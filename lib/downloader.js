'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const yt = require('./ytdlp');
const { buildFormatArgs, validateSection } = require('./validate');

// ---------- concurrency queue ----------
class Queue {
  constructor(max, maxWaiting) { this.max = max; this.maxWaiting = maxWaiting; this.active = 0; this.waiting = []; }
  acquire(signal) {
    return new Promise((resolve, reject) => {
      const grant = () => { this.active++; let done = false; resolve(() => { if (!done) { done = true; this.active--; this._next(); } }); };
      if (this.active < this.max) return grant();
      if (this.waiting.length >= this.maxWaiting) {
        return reject(Object.assign(new Error('Server busy'), {
          status: 503, code: 'BUSY', suggestion: 'Too many downloads in progress. Try again shortly.',
        }));
      }
      const entry = { grant, reject };
      this.waiting.push(entry);
      signal?.addEventListener('abort', () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) { this.waiting.splice(i, 1); reject(Object.assign(new Error('Aborted'), { code: 'ABORTED', status: 499 })); }
      }, { once: true });
    });
  }
  _next() { const n = this.waiting.shift(); if (n) n.grant(); }
}
const queue = new Queue(cfg.MAX_CONCURRENT, cfg.MAX_QUEUE);

const stats = { started: Date.now(), downloads: 0, failures: 0, bytes: 0, jobs: 0 };

// ---------- file helpers ----------
const MEDIA_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4a', 'mp3', 'opus', 'ogg', 'aac', 'flac', 'wav', 'm4v', '3gp', 'weba']);
const SUB_EXT = new Set(['srt', 'vtt']);
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/opus', ogg: 'audio/ogg', aac: 'audio/aac',
  flac: 'audio/flac', wav: 'audio/wav', weba: 'audio/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  vtt: 'text/vtt', srt: 'application/x-subrip', zip: 'application/zip',
};
const mimeOf = (ext) => MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';

function makeDir() {
  const id = crypto.randomUUID();
  const dir = path.join(cfg.TEMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}
function rmDir(dir) { if (dir && dir.startsWith(cfg.TEMP_DIR + path.sep)) fs.rm(dir, { recursive: true, force: true }, () => {}); }

function listFiles(dir, allowed) {
  return fs.readdirSync(dir)
    .map(name => ({ name, ext: path.extname(name).slice(1).toLowerCase(), path: path.join(dir, name) }))
    .filter(f => allowed.has(f.ext))
    .map(f => ({ ...f, size: fs.statSync(f.path).size }))
    .filter(f => f.size > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ---------- core download ----------
const PCT_RE = /\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([\d.]+\s*\S+))?(?:\s+at\s+([\d.]+\s*\S+\/s))?(?:\s+ETA\s+([\d:]+))?/;
const ITEM_RE = /\[download\]\s+Downloading item (\d+) of (\d+)/;
const PLAYLIST_RE = /\[download\]\s+Downloading (?:playlist|playlist:)\s*:?\s*(.+)$/;
const POST_RE = /^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|EmbedThumbnail|Metadata|ModifyChapters|SponsorBlock|FixupM3u8|FixupM4a|FixupStretched|FixupTimestamp)\]/;

/**
 * Download into a private temp directory.
 * Resolves to { id, dir, files:[{name,ext,path,size}], zip:boolean, filename, mime, size, playlistTitle }.
 * The caller owns the directory and must call rmDir(result.dir) when done (also done here on failure).
 */
async function download(url, opts, { signal, onStart, onProgress } = {}) {
  const release = await queue.acquire(signal);
  const { id, dir } = makeDir();
  let ok = false;
  try {
    onStart?.();
    const template = opts.playlist ? '%(playlist_index)03d - %(title).150B.%(ext)s' : '%(title).180B.%(ext)s';
    const extra = [
      '-o', path.join(dir, template),
      '--windows-filenames', '--no-mtime', '--newline', '--progress',
      '--concurrent-fragments', '4',
      '--max-filesize', cfg.MAX_FILESIZE,
      ...buildFormatArgs(opts),
    ];

    if (opts.subtitles) extra.push('--write-subs', '--write-auto-subs', '--sub-langs', opts.subLang, '--convert-subs', 'srt');
    if (opts.embedMetadata) extra.push('--embed-metadata');
    if (opts.embedThumbnail && opts.format !== 'webm' && opts.format !== 'ogg' && opts.format !== 'wav') {
      extra.push('--embed-thumbnail');
    }
    if (opts.sponsorblock) extra.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction,intro,outro');
    const section = validateSection(opts);
    if (section) extra.push('--download-sections', section);
    if (opts.playlist) extra.push('--yes-playlist', '--playlist-end', String(Math.min(opts.limit, cfg.MAX_PLAYLIST_ITEMS)));
    else extra.push('--no-playlist');

    let item = 1, total = 1, playlistTitle = null;
    await yt.run(yt.buildArgs(url, extra), {
      timeout: cfg.DOWNLOAD_TIMEOUT_MS,
      signal,
      onLine: (line) => {
        let m;
        if ((m = line.match(ITEM_RE))) { item = +m[1]; total = +m[2]; return; }
        if ((m = line.match(PLAYLIST_RE))) { playlistTitle = m[1].trim(); return; }
        if ((m = line.match(PCT_RE))) {
          const pct = parseFloat(m[1]);
          const overall = ((item - 1) + pct / 100) / total * 100;
          onProgress?.({ status: 'downloading', progress: Math.min(98, +overall.toFixed(1)), speed: m[3] || null, eta: m[4] || null, item, total });
          return;
        }
        if (POST_RE.test(line)) onProgress?.({ status: 'processing', progress: 99, message: 'Processing…', speed: null, eta: null });
      },
    });

    const media = listFiles(dir, MEDIA_EXT);
    const subs = listFiles(dir, SUB_EXT);
    if (!media.length) throw Object.assign(new Error('Download finished but no media file was produced'), { status: 502, code: 'NO_OUTPUT' });

    const files = [...media, ...subs];
    const zip = files.length > 1;
    let filename, mime, size;
    if (zip) {
      const base = (opts.playlist && playlistTitle) ? playlistTitle : path.basename(media[0].name, path.extname(media[0].name));
      filename = sanitizeName(base) + '.zip';
      mime = 'application/zip';
      size = require('./zip').zipSize(files.map(f => ({ path: f.path, name: f.name })));
    } else {
      filename = files[0].name; mime = mimeOf(files[0].ext); size = files[0].size;
    }
    stats.downloads++; stats.bytes += size;
    ok = true;
    return { id, dir, files, zip, filename, mime, size, playlistTitle };
  } catch (e) {
    stats.failures++;
    throw e;
  } finally {
    release();
    if (!ok) rmDir(dir);
  }
}

function sanitizeName(name) {
  return (String(name || 'download').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150)) || 'download';
}

/** Send a download() result to an Express response (supports Range for single files). */
function sendResult(res, result, next) {
  if (!result.zip) {
    return res.download(result.files[0].path, result.filename, (err) => {
      if (err && !res.headersSent) next?.(err);
    });
  }
  res.attachment(result.filename);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(result.size));
  require('./zip').writeZip(result.files.map((f) => ({ path: f.path, name: f.name })), res)
    .then(() => { if (!res.writableEnded) res.end(); })
    .catch((e) => {
      console.error('zip error:', e.message);
      if (!res.headersSent) next?.(e);
      else res.destroy(e);
    });
}

// ---------- jobs ----------
const jobs = new Map();

function publicJob(j) {
  return {
    id: j.id, type: j.type, status: j.status, progress: j.progress, message: j.message,
    speed: j.speed || null, eta: j.eta || null, item: j.item || null, total: j.total || null,
    url: j.url, result: j.result, error: j.error, code: j.code || null, suggestion: j.suggestion || null,
    createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}

function createJob(url, options) {
  const id = crypto.randomUUID();
  const job = {
    id, type: 'download', status: 'queued', progress: 0, message: 'Queued', url, options,
    createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null,
    controller: new AbortController(), listeners: new Set(), dir: null,
  };
  jobs.set(id, job);
  stats.jobs++;
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  for (const fn of job.listeners) { try { fn(publicJob(job)); } catch { /* ignore */ } }
}

function startJob(job) {
  const { options, url } = job;
  download(url, options, {
    signal: job.controller.signal,
    onStart: () => updateJob(job, { status: 'downloading', message: 'Starting download…', progress: 1 }),
    onProgress: (p) => {
      if (job.status === 'cancelled') return;
      updateJob(job, {
        status: p.status, progress: Math.max(job.progress, p.progress), speed: p.speed, eta: p.eta,
        item: p.item ?? job.item, total: p.total ?? job.total,
        message: p.message || `Downloading ${Math.round(p.progress)}%`,
      });
    },
  }).then((r) => {
    if (job.status === 'cancelled') return rmDir(r.dir);
    job.dir = r.dir; job.zip = r.zip; job.files = r.files; job.filename = r.filename; job.mime = r.mime;
    updateJob(job, {
      status: 'completed', progress: 100, message: 'Ready', speed: null, eta: null,
      result: { fileName: r.filename, size: r.size, mime: r.mime, files: r.files.length, download_path: `/api/job/${job.id}/file` },
    });
  }).catch((err) => {
    if (job.status === 'cancelled') return;
    const e = yt.toHttpError(err, 'Download failed');
    updateJob(job, {
      status: 'failed', progress: 0, message: 'Failed', speed: null, eta: null,
      error: e.details || e.message, code: e.code, suggestion: e.suggestion,
    });
  });
}

function cancelJob(job) {
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return false;
  updateJob(job, { status: 'cancelled', message: 'Cancelled', progress: 0 });
  job.controller.abort();
  return true;
}

function deleteJob(job) {
  cancelJob(job);
  rmDir(job.dir);
  jobs.delete(job.id);
}

// ---------- housekeeping ----------
function sweep() {
  const now = Date.now();
  for (const j of jobs.values()) if (now - j.createdAt > cfg.JOB_TTL_MS) deleteJob(j);
  try {
    for (const name of fs.readdirSync(cfg.TEMP_DIR)) {
      const p = path.join(cfg.TEMP_DIR, name);
      try { if (now - fs.statSync(p).mtimeMs > cfg.FILE_TTL_MS) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function init() {
  fs.rmSync(cfg.TEMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(cfg.TEMP_DIR, { recursive: true });
  setInterval(sweep, 5 * 60_000).unref();
}

function shutdown() {
  for (const j of jobs.values()) { try { j.controller.abort(); } catch { /* ignore */ } }
  try { fs.rmSync(cfg.TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = {
  queue, stats, jobs, download, sendResult, rmDir, mimeOf, sanitizeName,
  createJob, startJob, cancelJob, deleteJob, publicJob, updateJob, init, sweep, shutdown, listFiles, makeDir, SUB_EXT,
};
