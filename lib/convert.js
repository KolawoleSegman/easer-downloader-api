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

  // Scale / pad to even dimensions (required by libx264/libvpx)
  let vf = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const res = String(opts.resolution || '1280x720').toLowerCase();
  if (res === '1920x1080' || res === '1080p') {
    vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1";
  } else if (res === '1280x720' || res === '720p' || res === 'hd') {
    vf = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1";
  } else if (res === 'original' || res === 'source') {
    vf = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1';
  }

  const args = [
    '-loop', '1',
    '-framerate', '1',
    '-i', imagePath,
    '-i', audioPath,
    '-c:v', outFmt === 'webm' ? 'libvpx-vp9' : 'libx264',
    '-tune', 'stillimage',
    '-c:a', outFmt === 'webm' ? 'libopus' : 'aac',
    '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    '-vf', vf,
  ];

  if (outFmt === 'mp4') {
    args.push('-movflags', '+faststart');
  }
  // Keep encoding light for still-image videos
  if (outFmt === 'mp4') {
    args.push('-preset', 'veryfast', '-crf', '23');
  } else {
    args.push('-b:v', '1M', '-cpu-used', '4');
  }

  args.push(outPath);

  try {
    await runFfmpeg(args, { timeout: opts.timeout || 12 * 60_000, signal: opts.signal });
    const st = fs.statSync(outPath);
    if (!st.size) throw Object.assign(new Error('Output file is empty'), { status: 422, code: 'EMPTY_OUTPUT' });
    return {
      id,
      dir,
      filename: outName,
      path: outPath,
      size: st.size,
      mime: outFmt === 'webm' ? 'video/webm' : 'video/mp4',
      ext: outFmt,
    };
  } catch (e) {
    rmDir(dir);
    throw e;
  }
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
