'use strict';
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./lib/config');
const yt = require('./lib/ytdlp');
const dl = require('./lib/downloader');
const { createLimiter } = require('./lib/ratelimit');
const { validateUrl, parseOptions, buildFormatArgs } = require('./lib/validate');

const app = express();
if (cfg.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- cookies ----------
if (process.env.COOKIES_BASE64) {
  try {
    fs.writeFileSync(cfg.COOKIES_PATH, Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf8'), { mode: 0o600 });
    log('✅ Cookies file created from COOKIES_BASE64');
  } catch (e) { console.error('❌ Failed to write cookies:', e.message); }
}
dl.init();

// ---------- middleware ----------
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  next();
});

const origins = cfg.CORS_ORIGIN === '*' ? '*' : cfg.CORS_ORIGIN.split(',').map(s => s.trim());
app.use(cors({
  origin: origins,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

function authenticate(req, res, next) {
  if (!cfg.API_KEY) return next();
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const given = req.get('x-api-key') || bearer || (typeof req.query.key === 'string' ? req.query.key : '');
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(cfg.API_KEY).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED', suggestion: 'Send your key in the X-API-Key header.' });
}

const generalLimit = createLimiter({ windowMs: cfg.RATE_LIMIT_WINDOW_MS, max: cfg.RATE_LIMIT_MAX, name: 'general' });
const heavyLimit = createLimiter({ windowMs: cfg.RATE_LIMIT_WINDOW_MS, max: cfg.HEAVY_LIMIT_MAX, name: 'downloads' });
const noopCheck = (req, res, next) => next();

// Merge query + body (body wins) into one object
const input = (req) => ({ ...(req.query || {}), ...(req.body || {}) });

// ---------- root & health ----------
app.get('/api', (req, res) => res.json(apiIndex()));
function apiIndex() {
  return {
    status: 'OK', name: 'Easer Downloader API', version: cfg.VERSION,
    auth: cfg.API_KEY ? 'X-API-Key required for /api/*' : 'none',
    endpoints: {
      'GET  /health': 'Health + yt-dlp status',
      'GET  /api/stats': 'Usage counters and queue state',
      'POST /api/info': '{ url, playlist?, limit? } metadata, qualities, subtitle languages',
      'POST /api/extract': '{ url, format?, quality?, format_id? } direct media URLs (no server bandwidth)',
      'POST /api/download': '{ url, format?, quality?, subtitles?, sub_lang?, playlist?, limit?, start?, end?, sponsorblock?, embed_thumbnail?, embed_metadata?, format_id? } stream file (zip for playlists/subtitles)',
      'POST /api/thumbnail': '{ url } thumbnail as JPG',
      'POST /api/subtitles': '{ url, lang? } SRT (zip if several languages)',
      'POST /api/search': '{ query, limit?, source? } youtube | soundcloud',
      'POST /api/job/download': 'Start a background download → { jobId }',
      'POST /api/job/batch': '{ urls: [...], ...options } start up to 10 jobs',
      'GET  /api/job/:id': 'Poll status',
      'GET  /api/job/:id/events': 'Server-Sent Events progress stream',
      'GET  /api/job/:id/file': 'Fetch the finished file (supports Range)',
      'DELETE /api/job/:id': 'Cancel and/or delete a job',
      'GET  /api/jobs': 'Recent jobs',
      'POST /api/admin/update': 'Update yt-dlp (requires API_KEY to be configured)',
    },
  };
}

app.get('/health', wrap(async (req, res) => {
  const v = await yt.version();
  res.status(v.ok ? 200 : 503).json({
    status: v.ok ? 'healthy' : 'degraded', version: cfg.VERSION,
    yt_dlp: { version: v.value, ok: v.ok }, cookies: yt.hasCookies(), proxy: !!cfg.PROXY,
    active_downloads: dl.queue.active, queued: dl.queue.waiting.length, jobs_in_memory: dl.jobs.size,
    uptime_s: Math.floor(process.uptime()),
  });
}));

// Polling/SSE for job progress is cheap and must not eat the general budget
const isJobRead = (req) => req.method === 'GET' && /^\/jobs?(\/|$)/.test(req.path);
app.use('/api', authenticate, (req, res, next) => (isJobRead(req) ? next() : generalLimit(req, res, next)));

app.get('/api/stats', (req, res) => {
  res.json({
    success: true, ...dl.stats, uptime_s: Math.floor(process.uptime()),
    active: dl.queue.active, queued: dl.queue.waiting.length, max_concurrent: cfg.MAX_CONCURRENT,
    jobs: dl.jobs.size, memory_mb: Math.round(process.memoryUsage().rss / 1048576),
  });
});

// ---------- info (cached) ----------
const infoCache = new Map();
const INFO_TTL = 5 * 60_000;
function cacheGet(k) { const e = infoCache.get(k); if (e && Date.now() - e.at < INFO_TTL) return e.v; infoCache.delete(k); return null; }
function cacheSet(k, v) {
  if (infoCache.size > 200) infoCache.delete(infoCache.keys().next().value);
  infoCache.set(k, { at: Date.now(), v });
}

function mapFormat(f) {
  return {
    format_id: f.format_id, ext: f.ext,
    resolution: f.resolution || (f.height ? `${f.width || '?'}x${f.height}` : null),
    height: f.height || null, fps: f.fps || null, vcodec: f.vcodec, acodec: f.acodec,
    filesize: f.filesize || f.filesize_approx || null, tbr: f.tbr || null, format_note: f.format_note || null,
    has_video: !!f.vcodec && f.vcodec !== 'none', has_audio: !!f.acodec && f.acodec !== 'none',
  };
}

function mapEntry(info, light = false) {
  const base = {
    id: info.id, title: info.title,
    url: info.webpage_url || info.original_url || info.url || null,
    uploader: info.uploader || info.channel || info.creator || null,
    duration: info.duration ?? null,
    thumbnail: info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url || null,
    extractor: info.extractor_key || info.extractor || null,
  };
  if (light) return base;
  const formats = (info.formats || []).filter(f => f.url || f.manifest_url).map(mapFormat);
  const heights = [...new Set(formats.filter(f => f.has_video && f.height).map(f => f.height))].sort((a, b) => b - a);
  return {
    ...base,
    description: (info.description || '').slice(0, 500),
    view_count: info.view_count ?? null, like_count: info.like_count ?? null,
    upload_date: info.upload_date || null, is_live: !!info.is_live,
    age_limit: info.age_limit ?? null,
    chapters: (info.chapters || []).slice(0, 50).map(c => ({ title: c.title, start: c.start_time, end: c.end_time })),
    available_heights: heights,
    audio_available: formats.some(f => f.has_audio),
    subtitle_langs: Object.keys(info.subtitles || {}),
    auto_caption_langs: Object.keys(info.automatic_captions || {}).slice(0, 40),
    formats: formats.slice(-40),
  };
}

app.post('/api/info', wrap(async (req, res) => {
  const b = input(req);
  const url = validateUrl(b.url);
  const wantPlaylist = b.playlist === true || b.playlist === 'true' || b.playlist === '1';
  const limit = Math.max(1, Math.min(parseInt(b.limit, 10) || cfg.MAX_PLAYLIST_ITEMS, 50));
  const key = `${url}|${wantPlaylist}|${limit}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ...cached, cached: true });

  const extra = ['--dump-json', '--no-download'];
  if (wantPlaylist) extra.push('--flat-playlist', '--yes-playlist', '--playlist-end', String(limit));
  else extra.push('--no-playlist');

  let result;
  try { result = await yt.run(yt.buildArgs(url, extra), { timeout: 120_000 }); }
  catch (e) { throw yt.toHttpError(e, 'Failed to fetch media info'); }

  const entries = result.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!entries.length) throw Object.assign(new Error('No metadata returned'), { status: 502, code: 'NO_METADATA' });

  const body = (wantPlaylist && entries.length > 1)
    ? { success: true, type: 'playlist', playlist_title: entries[0].playlist_title || null, count: entries.length, entries: entries.map(e => mapEntry(e, true)) }
    : { success: true, type: 'video', ...mapEntry(entries[0]) };
  cacheSet(key, body);
  res.json(body);
}));

// ---------- extract (direct URLs) ----------
app.post('/api/extract', wrap(async (req, res) => {
  const b = input(req);
  const url = validateUrl(b.url);
  const opts = parseOptions(b);
  const args = yt.buildArgs(url, ['--no-playlist', '--dump-single-json', '--no-download', ...buildFormatArgs(opts, { forExtract: true })]);

  let r;
  try { r = await yt.run(args, { timeout: 90_000 }); }
  catch (e) { throw yt.toHttpError(e, 'Failed to extract media URLs'); }

  let info;
  try { info = JSON.parse(r.stdout); } catch { throw Object.assign(new Error('Could not parse yt-dlp output'), { status: 502, code: 'PARSE' }); }
  const sel = (info.requested_formats && info.requested_formats.length) ? info.requested_formats : [info];
  const streams = sel.filter(f => f.url).map(f => ({
    url: f.url, format_id: f.format_id || null, ext: f.ext || null,
    type: (f.vcodec && f.vcodec !== 'none') ? ((f.acodec && f.acodec !== 'none') ? 'video+audio' : 'video') : 'audio',
    height: f.height || null, filesize: f.filesize || f.filesize_approx || null, headers: f.http_headers || null,
  }));
  res.json({
    success: true, id: info.id, title: info.title, ext: info.ext || null, duration: info.duration ?? null,
    thumbnail: info.thumbnail || null, streams, urls: streams.map(s => s.url), primary_url: streams[0]?.url || null,
    note: 'Direct URLs expire quickly and may need the listed headers. Streams of type video + audio must be merged (e.g. with ffmpeg).',
  });
}));

// ---------- download (streamed) ----------
async function handleDownload(req, res, next) {
  const b = input(req);
  const url = validateUrl(b.url);
  const opts = parseOptions(b);

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  let result;
  try {
    log(`[${req.id}] 📥 ${url} fmt=${opts.format} q=${opts.quality || 'best'}`);
    result = await dl.download(url, opts, { signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    throw e.status && e.code ? e : yt.toHttpError(e, 'Failed to download media');
  }
  if (ac.signal.aborted) return dl.rmDir(result.dir);

  res.on('close', () => dl.rmDir(result.dir));
  res.setHeader('X-File-Name', encodeURIComponent(result.filename));
  res.setHeader('X-File-Size', String(result.size));
  dl.sendResult(res, result, next);
}
app.post('/api/download', heavyLimit, wrap(handleDownload));
app.get('/api/download', heavyLimit, wrap(handleDownload));

// ---------- jobs ----------
function newJob(body) {
  const url = validateUrl(body.url);
  const options = parseOptions(body);
  const job = dl.createJob(url, options);
  dl.startJob(job);
  return job;
}

app.post('/api/job/download', heavyLimit, wrap(async (req, res) => {
  if (dl.queue.waiting.length >= cfg.MAX_QUEUE && dl.queue.active >= cfg.MAX_CONCURRENT) {
    throw Object.assign(new Error('Server busy'), { status: 503, code: 'BUSY', suggestion: 'Queue is full. Try again shortly.' });
  }
  const job = newJob(req.body || {});
  res.status(202).json({
    success: true, jobId: job.id, status: job.status,
    poll: `/api/job/${job.id}`, events: `/api/job/${job.id}/events`, file: `/api/job/${job.id}/file`,
  });
}));

app.post('/api/job/batch', heavyLimit, wrap(async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 10) : null;
  if (!urls || !urls.length) throw Object.assign(new Error('"urls" must be a non-empty array (max 10)'), { status: 400 });
  const jobs = [];
  for (const u of urls) {
    try { const j = newJob({ ...req.body, url: u }); jobs.push({ url: u, jobId: j.id, status: j.status }); }
    catch (e) { jobs.push({ url: u, error: e.message, code: e.code || 'INVALID' }); }
  }
  res.status(202).json({ success: true, count: jobs.length, jobs });
}));

const getJob = (req) => {
  const j = dl.jobs.get(req.params.id);
  if (!j) throw Object.assign(new Error('Job not found or expired'), { status: 404, code: 'NOT_FOUND' });
  return j;
};

app.get('/api/jobs', (req, res) => {
  const list = [...dl.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(dl.publicJob);
  res.json({ success: true, jobs: list });
});

app.get('/api/job/:id', (req, res) => res.json(dl.publicJob(getJob(req))));

app.get('/api/job/:id/events', (req, res) => {
  const job = getJob(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (j) => { res.write(`data: ${JSON.stringify(j)}\n\n`); if (['completed', 'failed', 'cancelled'].includes(j.status)) { cleanup(); res.end(); } };
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  const cleanup = () => { clearInterval(ping); job.listeners.delete(send); };
  job.listeners.add(send);
  req.on('close', cleanup);
  send(dl.publicJob(job));
});

app.get('/api/job/:id/file', (req, res, next) => {
  const job = getJob(req);
  if (job.status !== 'completed' || !job.result) {
    return res.status(409).json({ success: false, error: 'File not ready', status: job.status });
  }
  if (!job.dir || !fs.existsSync(job.dir)) return res.status(410).json({ success: false, error: 'File already cleaned up' });
  const r = { zip: job.zip, files: job.files, filename: job.filename, size: job.result.size };
  dl.sendResult(res, r, next);
});

app.delete('/api/job/:id', (req, res) => {
  const job = getJob(req);
  dl.deleteJob(job);
  res.json({ success: true, deleted: job.id });
});

// ---------- thumbnail ----------
app.post('/api/thumbnail', wrap(async (req, res, next) => {
  const url = validateUrl(input(req).url);
  const { dir } = dl.makeDir();
  res.on('close', () => dl.rmDir(dir));
  try {
    await yt.run(yt.buildArgs(url, ['--no-playlist', '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', path.join(dir, 'thumbnail.%(ext)s')]), { timeout: 60_000 });
  } catch (e) { dl.rmDir(dir); throw yt.toHttpError(e, 'Failed to get thumbnail'); }
  const f = dl.listFiles(dir, new Set(['jpg', 'jpeg', 'png', 'webp']))[0];
  if (!f) throw Object.assign(new Error('No thumbnail produced'), { status: 404, code: 'NO_THUMBNAIL' });
  res.download(f.path, `thumbnail.${f.ext}`, (err) => { if (err && !res.headersSent) next(err); });
}));

// ---------- subtitles ----------
app.post('/api/subtitles', wrap(async (req, res, next) => {
  const b = input(req);
  const url = validateUrl(b.url);
  const { sub_lang } = parseOptions({ sub_lang: b.lang || b.sub_lang });
  const fmt = String(b.format || 'srt').toLowerCase();
  if (!['srt', 'vtt'].includes(fmt)) throw Object.assign(new Error('format must be srt or vtt'), { status: 400 });
  const { dir } = dl.makeDir();
  res.on('close', () => dl.rmDir(dir));
  try {
    await yt.run(yt.buildArgs(url, ['--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', sub_lang, '--convert-subs', fmt, '-o', path.join(dir, 'subs')]), { timeout: 90_000 });
  } catch (e) { dl.rmDir(dir); throw yt.toHttpError(e, 'Failed to get subtitles'); }
  const files = dl.listFiles(dir, dl.SUB_EXT);
  if (!files.length) {
    throw Object.assign(new Error('No subtitles found for this language'), { status: 404, code: 'NO_SUBTITLES', suggestion: 'Call /api/info to see subtitle_langs and auto_caption_langs.' });
  }
  const result = files.length === 1
    ? { zip: false, files, filename: files[0].name.replace(/^subs\./, ''), size: files[0].size }
    : { zip: true, files, filename: 'subtitles.zip', size: require('./lib/zip').zipSize(files.map(f => ({ path: f.path, name: f.name }))) };
  res.setHeader('X-Subtitle-Files', files.map(f => f.name).join(','));
  dl.sendResult(res, result, next);
}));

// ---------- search ----------
const SEARCH_PREFIX = { youtube: 'ytsearch', soundcloud: 'scsearch' };
app.post('/api/search', wrap(async (req, res) => {
  const b = input(req);
  const query = typeof b.query === 'string' ? b.query.replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, 200) : '';
  if (!query) throw Object.assign(new Error('"query" is required'), { status: 400 });
  const source = String(b.source || 'youtube').toLowerCase();
  if (!SEARCH_PREFIX[source]) throw Object.assign(new Error('source must be youtube or soundcloud'), { status: 400 });
  const limit = Math.max(1, Math.min(parseInt(b.limit, 10) || 8, 20));

  let r;
  try { r = await yt.run(yt.buildArgs(`${SEARCH_PREFIX[source]}${limit}:${query}`, ['--flat-playlist', '--dump-json', '--no-download']), { timeout: 60_000 }); }
  catch (e) { throw yt.toHttpError(e, 'Search failed'); }

  const results = r.stdout.split('\n').filter(Boolean).map(l => {
    try {
      const j = JSON.parse(l);
      return {
        id: j.id, title: j.title,
        url: j.url || j.webpage_url || (source === 'youtube' && j.id ? `https://www.youtube.com/watch?v=${j.id}` : null),
        duration: j.duration ?? null, channel: j.channel || j.uploader || null,
        view_count: j.view_count ?? null, thumbnail: j.thumbnails?.[j.thumbnails.length - 1]?.url || j.thumbnail || null,
      };
    } catch { return null; }
  }).filter(Boolean);
  res.json({ success: true, query, source, count: results.length, results });
}));

// ---------- admin ----------
app.post('/api/admin/update', wrap(async (req, res) => {
  if (!cfg.API_KEY) throw Object.assign(new Error('Set API_KEY to enable admin endpoints'), { status: 403, code: 'ADMIN_DISABLED' });
  try { res.json({ success: true, output: await yt.selfUpdate(), version: (await yt.version()).value }); }
  catch (e) { throw yt.toHttpError(e, 'Update failed'); }
}));

// ---------- debug (only with DEBUG=true) ----------
app.get('/debug', authenticate, wrap(async (req, res) => {
  if (process.env.DEBUG !== 'true') return res.status(404).json({ error: 'Not found' });
  const url = validateUrl(req.query.url || 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  try {
    const r = await yt.run(yt.buildArgs(url, ['--no-playlist', '--print', 'url', '--format', 'bv*+ba/b']), { timeout: 60_000 });
    res.json({ success: true, url, urls: r.stdout.trim().split('\n').filter(Boolean), cookies: yt.hasCookies() });
  } catch (e) { throw yt.toHttpError(e, 'Debug probe failed'); }
}));

// ---------- 404 & errors ----------
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found', code: 'NOT_FOUND' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  if (err.type === 'entity.parse.failed') { status = 400; err.message = 'Invalid JSON body'; }
  if (err.type === 'entity.too.large') status = 413;
  if (status >= 500) console.error(`[${req.id}] 💥`, err.stack || err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({
    success: false,
    error: status >= 500 && !err.code ? 'Internal server error' : err.message,
    code: err.code || (status === 400 ? 'BAD_REQUEST' : undefined),
    details: err.details, suggestion: err.suggestion, stderr: err.stderr,
    requestId: req.id,
  });
});

// ---------- start & shutdown ----------
const server = app.listen(cfg.PORT, async () => {
  const v = await yt.version();
  log(`🚀 Easer Downloader API v${cfg.VERSION} on :${cfg.PORT}`);
  log(`📌 yt-dlp ${v.ok ? v.value : '❌ ' + v.value} (${yt.BIN}) | 🍪 ${yt.hasCookies() ? 'cookies' : 'no cookies'} | 🌐 ${cfg.PROXY ? 'proxy' : 'no proxy'} | 🔐 ${cfg.API_KEY ? 'auth on' : 'auth off'}`);
  log(`📂 ${cfg.TEMP_DIR} | concurrent ${cfg.MAX_CONCURRENT} (+${cfg.MAX_QUEUE} queued) | max file ${cfg.MAX_FILESIZE}`);
});
server.requestTimeout = 0;           // long streaming downloads
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

if (cfg.YTDLP_UPDATE_HOURS > 0) {
  const t = setInterval(() => yt.selfUpdate().then(o => log('🔄 yt-dlp:', o)).catch(e => log('yt-dlp update skipped:', e.message)), cfg.YTDLP_UPDATE_HOURS * 3_600_000);
  t.unref();
}

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  log(`${sig} received, shutting down…`);
  server.close(() => { dl.shutdown(); process.exit(0); });
  setTimeout(() => { dl.shutdown(); process.exit(0); }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
module.exports = app;
