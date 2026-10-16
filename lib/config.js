'use strict';
const path = require('path');
const os = require('os');

const int = (v, d, min = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? n : d;
};

module.exports = {
  VERSION: '4.0.1',
  PORT: int(process.env.PORT, 5000, 1),
  API_KEY: process.env.API_KEY || null,                       // optional: require X-API-Key / ?key=
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',                // comma separated list or *
  PROXY: process.env.PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
  RATE_LIMIT_MAX: int(process.env.RATE_LIMIT_MAX, 30, 1),     // requests per window per IP
  RATE_LIMIT_WINDOW_MS: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 1000),
  HEAVY_LIMIT_MAX: int(process.env.HEAVY_LIMIT_MAX, 6, 1),    // downloads/jobs per window per IP
  MAX_CONCURRENT: int(process.env.MAX_CONCURRENT, 3, 1),
  MAX_QUEUE: int(process.env.MAX_QUEUE, 20, 0),
  DOWNLOAD_TIMEOUT_MS: int(process.env.DOWNLOAD_TIMEOUT_MS, 8 * 60_000, 1000),
  MAX_PLAYLIST_ITEMS: int(process.env.MAX_PLAYLIST_ITEMS, 15, 1),
  MAX_FILESIZE: process.env.MAX_FILESIZE || '1G',             // passed to yt-dlp --max-filesize
  FILE_TTL_MS: int(process.env.FILE_TTL_MS, 45 * 60_000, 60_000),
  JOB_TTL_MS: int(process.env.JOB_TTL_MS, 30 * 60_000, 60_000),
  YTDLP_UPDATE_HOURS: int(process.env.YTDLP_UPDATE_HOURS, 12, 0), // 0 = disabled
  ALLOWED_HOSTS: (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  TRUST_PROXY: process.env.TRUST_PROXY !== 'false',
  TEMP_DIR: path.join(process.env.TEMP_DIR || os.tmpdir(), 'easer-downloads'),
  COOKIES_PATH: path.join(__dirname, '..', 'cookies.txt'),
  ROOT: path.join(__dirname, '..'),
};
