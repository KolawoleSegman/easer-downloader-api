'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

// ---------- binary resolution ----------
function resolveBinary() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const candidates = [
    path.join(cfg.ROOT, 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/render/project/src/yt-dlp',
    path.join(process.env.HOME || '', '.local/bin/yt-dlp'),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return 'yt-dlp';
}
const BIN = resolveBinary();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Build a full yt-dlp argv. The URL is always passed after `--` so it can never be parsed as an option. */
function buildArgs(url, extra = []) {
  const args = [
    '--no-warnings', '--ignore-config', '--no-cache-dir',
    '--socket-timeout', '30',
    '--retries', '5', '--fragment-retries', '5',
    '--user-agent', UA,
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--extractor-args', 'youtube:player_client=web,mweb,android,tv',
    ...extra,
  ];
  if (cfg.PROXY) args.push('--proxy', cfg.PROXY);
  if (hasCookies()) args.push('--cookies', cfg.COOKIES_PATH);
  if (url) args.push('--', url);
  return args;
}

function hasCookies() { try { return fs.statSync(cfg.COOKIES_PATH).size > 0; } catch { return false; } }

// ---------- process runner ----------
function killTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/**
 * Run yt-dlp. Rejects with { message, code, stderr, exitCode }.
 * options: { timeout, signal, onLine(line, stream), maxBuffer }
 */
function run(args, { timeout = 45_000, signal, onLine, maxBuffer = 80 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject({ message: 'Aborted', code: 'ABORTED', stderr: '' });

    // When YTDLP_PATH points at a .js file (test fake or custom wrapper), run it with node
    // so tests work without needing +x / executable mounts.
    let bin = BIN;
    let argv = args;
    if (bin.endsWith('.js') || process.env.YTDLP_USE_NODE === '1') {
      argv = [bin, ...args];
      bin = process.execPath;
    }

    let child;
    try {
      child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: process.env });
    } catch (e) {
      return reject({ message: e.message, code: 'SPAWN', stderr: '' });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let overflow = false;
    const partial = { out: '', err: '' };

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(val);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, { message: `yt-dlp timed out after ${Math.round(timeout / 1000)}s`, code: 'TIMEOUT', stderr });
    }, timeout);
    const onAbort = () => { killTree(child); finish(reject, { message: 'Aborted', code: 'ABORTED', stderr }); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const feed = (key, stream) => (chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'out') { if (stdout.length < maxBuffer) stdout += text; else overflow = true; }
      else { stderr = (stderr + text).slice(-65536); }
      if (onLine) {
        partial[key] += text;
        const parts = partial[key].split(/\r|\n/);
        partial[key] = parts.pop();
        for (const l of parts) if (l) onLine(l, stream);
      }
    };
    child.stdout.on('data', feed('out', 'out'));
    child.stderr.on('data', feed('err', 'err'));

    child.on('error', (e) => finish(reject, {
      message: e.code === 'ENOENT' ? `yt-dlp binary not found (${BIN})` : e.message,
      code: e.code === 'ENOENT' ? 'ENOENT' : 'SPAWN', stderr,
    }));
    child.on('close', (exitCode) => {
      if (onLine) { for (const [k, s] of [['out', 'out'], ['err', 'err']]) if (partial[k]) onLine(partial[k], s); }
      if (overflow) return finish(reject, { message: 'yt-dlp output too large', code: 'OVERFLOW', stderr });
      if (exitCode === 0) return finish(resolve, { stdout, stderr });
      finish(reject, { message: lastError(stderr) || `yt-dlp exited with code ${exitCode}`, code: 'EXIT', exitCode, stderr });
    });
  });
}

// ---------- error handling ----------
function sanitize(text = '') {
  return String(text)
    .split(cfg.COOKIES_PATH).join('<cookies>')
    .split(cfg.TEMP_DIR).join('<tmp>')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1***@')   // proxy creds
    .slice(0, 400);
}

function lastError(stderr = '') {
  const lines = stderr.split('\n').map(s => s.trim()).filter(l => /^ERROR:/i.test(l));
  return sanitize((lines[lines.length - 1] || '').replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, ''));
}

/** Map yt-dlp output to an HTTP status + stable error code + human hint. */
function classify(err = {}) {
  const s = `${err.stderr || ''}\n${err.message || ''}`;
  const has = (...r) => r.some(x => (x instanceof RegExp ? x.test(s) : s.includes(x)));
  if (err.code === 'ABORTED') return { status: 499, code: 'ABORTED', suggestion: 'Request was cancelled.' };
  if (err.code === 'TIMEOUT') return { status: 504, code: 'TIMEOUT', suggestion: 'The operation took too long. Try a lower quality, a shorter clip, or an audio-only format.' };
  if (err.code === 'ENOENT') return { status: 500, code: 'YTDLP_MISSING', suggestion: 'yt-dlp is not installed on the server.' };
  if (has('Private video', 'This video is private'))
    return { status: 403, code: 'PRIVATE', suggestion: 'This video is private.' };
  if (has('Sign in to confirm', 'confirm you’re not a bot', "confirm you're not a bot", 'cookies are no longer valid', 'login required', 'Sign in'))
    return { status: 403, code: 'AUTH_REQUIRED', suggestion: 'The site wants a signed-in session. Export fresh cookies (Netscape format) and set COOKIES_BASE64.' };
  if (has('HTTP Error 429', 'Too Many Requests', /rate.?limit/i))
    return { status: 429, code: 'SITE_RATE_LIMITED', suggestion: 'The source site is rate limiting this server. Wait a few minutes, set PROXY, or refresh cookies.' };
  if (has('age-restricted', 'confirm your age', 'Age-restricted'))
    return { status: 403, code: 'AGE_RESTRICTED', suggestion: 'Age-restricted content needs cookies from a signed-in adult account.' };
  if (has('not available in your country', 'geo', 'blocked it in your country', 'blocked in your country'))
    return { status: 451, code: 'GEO_BLOCKED', suggestion: 'Blocked in the server’s region. Try a PROXY in an allowed country.' };
  if (has('Video unavailable', 'has been removed', 'no longer available', 'does not exist', 'HTTP Error 404'))
    return { status: 404, code: 'UNAVAILABLE', suggestion: 'The video is unavailable or was removed.' };
  if (has('Unsupported URL', 'is not a valid URL'))
    return { status: 422, code: 'UNSUPPORTED_URL', suggestion: 'This URL is not supported by yt-dlp.' };
  if (has('File is larger than max-filesize', 'larger than max-filesize'))
    return { status: 413, code: 'TOO_LARGE', suggestion: `File exceeds the server limit (${cfg.MAX_FILESIZE}). Pick a lower quality or use /api/extract.` };
  if (has('Requested format is not available', 'requested format not available'))
    return { status: 422, code: 'FORMAT_UNAVAILABLE', suggestion: 'That format/quality is not offered for this video. Call /api/info to see available formats.' };
  if (has('is live', 'live event', 'This live event will begin'))
    return { status: 422, code: 'LIVE', suggestion: 'Live streams cannot be downloaded this way.' };
  if (has('ffmpeg', 'ffprobe') && has('not found', 'not installed'))
    return { status: 500, code: 'FFMPEG_MISSING', suggestion: 'ffmpeg is required for this operation.' };
  return { status: 502, code: 'UPSTREAM_ERROR', suggestion: 'Try again later or with a different URL.' };
}

/** Convert a yt-dlp failure into an Error that the Express error handler understands. */
function toHttpError(err, message) {
  if (err && err.status && err instanceof Error) return err;
  const c = classify(err);
  const e = new Error(message);
  Object.assign(e, c, {
    details: err?.message ? sanitize(err.message) : undefined,
    stderr: process.env.DEBUG === 'true' ? sanitize(err?.stderr || '') : undefined,
  });
  return e;
}

// ---------- misc ----------
let versionCache = { at: 0, value: null, ok: false };
async function version({ force = false } = {}) {
  if (!force && Date.now() - versionCache.at < 5 * 60_000) return versionCache;
  try {
    const r = await run(['--version'], { timeout: 10_000 });
    versionCache = { at: Date.now(), value: r.stdout.trim(), ok: true };
  } catch (e) {
    versionCache = { at: Date.now(), value: e.message, ok: false };
  }
  return versionCache;
}

async function selfUpdate() {
  const r = await run(['-U'], { timeout: 120_000 });
  await version({ force: true });
  return (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' ').slice(0, 300);
}

module.exports = { BIN, run, buildArgs, classify, toHttpError, sanitize, hasCookies, version, selfUpdate };
