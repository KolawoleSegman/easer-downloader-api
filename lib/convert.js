'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const MAX_CONVERT_BYTES = 200 * 1024 * 1024; // 200 MB soft limit for uploads
const ALLOWED_VIDEO = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', '3gp', 'flv', 'ts', 'mts']);
const ALLOWED_AUDIO = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'flac', 'wav', 'weba', 'wma']);
const ALLOWED_IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp']);

const AUDIO_CODECS = {
  mp3:  ['-c:a', 'libmp3lame', '-q:a', '2'],
  m4a:  ['-c:a', 'aac', '-b:a', '192k'],
  aac:  ['-c:a', 'aac', '-b:a', '192k'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
  flac: ['-c:a', 'flac'],
  wav:  ['-c:a', 'pcm_s16le'],
};

function extOf(name) {
  return path.extname(name || '').slice(1).toLowerCase();
}

function safeName(name, fallback) {
  const base = path.basename(String(name || fallback || 'file'))
    .replace(/[^\w.\- ()[\]]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback || 'file';
  return base;
}

function makeWorkDir() {
  const id = crypto.randomUUID();
  const dir = path.join(cfg.TEMP_DIR, 'convert-' + id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

function rmDir(dir) {
  if (dir && dir.startsWith(cfg.TEMP_DIR + path.sep)) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

function runFfmpeg(args, { timeout = 10 * 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });

    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(Object.assign(new Error('Conversion timed out'), { status: 504, code: 'TIMEOUT' }));
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(new Error('ffmpeg is not available: ' + err.message), { status: 500, code: 'FFMPEG_MISSING' }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ ok: true });
      else {
        const msg = (stderr || '').trim().split('\n').pop() || `ffmpeg exited with code ${code}`;
        reject(Object.assign(new Error(msg), { status: 422, code: 'CONVERT_FAILED', stderr: stderr.slice(-1500) }));
      }
    });
  });
}

/**
 * Video → Audio
 * @param {string} inputPath
 * @param {string} outFormat  mp3|m4a|opus|flac|wav
 * @param {object} opts
 */
async function videoToAudio(inputPath, outFormat = 'mp3', opts = {}) {
  const fmt = String(outFormat || 'mp3').toLowerCase();
  if (!AUDIO_CODECS[fmt]) {
    throw Object.assign(new Error('Unsupported audio format. Use mp3, m4a, opus, flac or wav.'), { status: 400, code: 'BAD_FORMAT' });
  }

  const { id, dir } = makeWorkDir();
  const outName = safeName(path.basename(inputPath, path.extname(inputPath)), 'audio') + '.' + fmt;
  const outPath = path.join(dir, outName);

  const args = ['-i', inputPath, '-vn', ...AUDIO_CODECS[fmt]];
  if (opts.start != null) args.push('-ss', String(opts.start));
  if (opts.end != null) args.push('-to', String(opts.end));
  args.push(outPath);

  try {
    await runFfmpeg(args, { timeout: opts.timeout, signal: opts.signal });
    const st = fs.statSync(outPath);
    if (!st.size) throw Object.assign(new Error('Output file is empty'), { status: 422, code: 'EMPTY_OUTPUT' });
    return {
      id,
      dir,
      filename: outName,
      path: outPath,
      size: st.size,
      mime: fmt === 'mp3' ? 'audio/mpeg' : fmt === 'm4a' || fmt === 'aac' ? 'audio/mp4' : fmt === 'opus' ? 'audio/opus' : fmt === 'flac' ? 'audio/flac' : 'audio/wav',
      ext: fmt,
    };
  } catch (e) {
    rmDir(dir);
    throw e;
  }
}

/**
 * Audio + Image → Video (static image background)
 * @param {string} audioPath
 * @param {string} imagePath
 * @param {object} opts  { resolution?: '1280x720'|'1920x1080'|'original', format?: 'mp4'|'webm' }
 */
async function audioToVideo(audioPath, imagePath, opts = {}) {
  const outFmt = String(opts.format || 'mp4').toLowerCase() === 'webm' ? 'webm' : 'mp4';
  const { id, dir } = makeWorkDir();
  const outName = safeName(path.basename(audioPath, path.extname(audioPath)), 'video') + '.' + outFmt;
  const outPath = path.join(dir, outName);
  const res = String(opts.resolution || '1280x720').toLowerCase();
  const size = res === '1920x1080' || res === '1080p' ? '1920x1080' : '1280x720';
  const [width, height] = size.split('x').map(Number);
  const mode = String(opts.backgroundMode || (imagePath ? 'image' : 'preset')).toLowerCase();
  const palettes = { midnight: '#101a36', ocean: '#063b52', sunset: '#542b50', ember: '#48251f', forest: '#123b32', violet: '#30205c', black: '#090b10', cream: '#e9dfca' };
  const bg = palettes[String(opts.backgroundPreset || 'midnight').toLowerCase()] || palettes.midnight;
  const candidate = String(opts.waveformColor || '#38bdf8').replace(/[^#a-fA-F0-9]/g, '');
  const waveColor = /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate : '#38bdf8';
  const args = [];

  if (mode === 'image') {
    if (!imagePath) throw Object.assign(new Error('Choose a background image or select a preset background.'), { status: 400, code: 'NO_IMAGE' });
    args.push('-loop', '1', '-framerate', '30', '-i', imagePath);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=${bg}:s=${size}:r=30`);
  }
  args.push('-i', audioPath);

  if (mode === 'visualizer') {
    const waveH = Math.max(120, Math.round(height * 0.28));
    const graph = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[base];[1:a]showwaves=s=${width}x${waveH}:mode=cline:rate=30:colors=${waveColor},format=rgba,colorkey=black:0.12:0.08[wave];[base][wave]overlay=0:(H-h)/2,format=yuv420p[outv]`;
    args.push('-filter_complex', graph, '-map', '[outv]', '-map', '1:a:0');
  } else {
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
    args.push('-vf', vf, '-map', '0:v:0', '-map', '1:a:0');
  }
  args.push('-c:v', outFmt === 'webm' ? 'libvpx-vp9' : 'libx264', '-c:a', outFmt === 'webm' ? 'libopus' : 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-shortest');
  if (outFmt === 'mp4') args.push('-movflags', '+faststart', '-preset', 'veryfast', '-crf', '23');
  else args.push('-b:v', '1M', '-cpu-used', '4');
  args.push(outPath);

  try {
    await runFfmpeg(args, { timeout: opts.timeout || 20 * 60_000, signal: opts.signal });
    const st = fs.statSync(outPath);
    if (!st.size) throw Object.assign(new Error('Output file is empty'), { status: 422, code: 'EMPTY_OUTPUT' });
    return { id, dir, filename: outName, path: outPath, size: st.size, mime: outFmt === 'webm' ? 'video/webm' : 'video/mp4', ext: outFmt };
  } catch (e) { rmDir(dir); throw e; }
}

module.exports = {
  MAX_CONVERT_BYTES,
  ALLOWED_VIDEO,
  ALLOWED_AUDIO,
  ALLOWED_IMAGE,
  extOf,
  safeName,
  videoToAudio,
  audioToVideo,
  rmDir,
  makeWorkDir,
};
