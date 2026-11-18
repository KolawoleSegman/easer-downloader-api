'use strict';
const net = require('net');
const { ALLOWED_HOSTS } = require('./config');

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) return PRIVATE_V4.some(r => r.test(h));
  if (net.isIPv6(h)) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe80/.test(h) || /^::ffff:/.test(h);
  return false;
}

/** Returns a normalised http(s) URL string or throws an Error with .status = 400. */
function validateUrl(input) {
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  if (typeof input !== 'string' || !input.trim()) throw fail('A "url" string is required');
  const raw = input.trim();
  if (raw.length > 2048) throw fail('URL too long');
  if (raw.startsWith('-')) throw fail('Invalid URL');
  let u;
  try { u = new URL(raw); } catch { throw fail('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail('Only http(s) URLs are supported');
  if (isPrivateHost(u.hostname)) throw fail('Private or local addresses are not allowed');
  if (ALLOWED_HOSTS.length) {
    const ok = ALLOWED_HOSTS.some(a => u.hostname === a || u.hostname.endsWith('.' + a));
    if (!ok) throw fail('This host is not allowed on this server');
  }
  return u.toString();
}

const FORMATS = new Set(['video', 'mp4', 'webm', 'mkv', 'audio', 'mp3', 'm4a', 'opus', 'flac', 'wav', 'ogg']);
const AUDIO = new Set(['audio', 'mp3', 'm4a', 'opus', 'flac', 'wav', 'ogg']);

/** Only allow characters that are legitimate in yt-dlp format selectors. */
const FORMAT_ID_RE = /^[A-Za-z0-9_\-+*/,.:\[\]()<>=!^$~@&| ]{1,200}$/;

function parseOptions(src = {}) {
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  const format = String(src.format || 'video').toLowerCase();
  if (!FORMATS.has(format)) throw fail(`Unsupported format "${format}". Use one of: ${[...FORMATS].join(', ')}`);

  let quality = src.quality;
  if (quality !== undefined && quality !== null && quality !== '') {
    quality = String(quality).toLowerCase().replace(/p$/, '');
    if (!(quality === 'best' || quality === 'worst' || /^\d{2,4}$/.test(quality))) throw fail('quality must be best, worst or a height like 720');
  } else quality = null;

  let formatId = src.format_id;
  if (formatId) {
    formatId = String(formatId);
    if (!FORMAT_ID_RE.test(formatId) || formatId.startsWith('-')) throw fail('Invalid format_id');
  } else formatId = null;

  let subLang = String(src.sub_lang || 'en.*,en');
  if (!/^[A-Za-z0-9_.*,\-]{1,60}$/.test(subLang)) throw fail('Invalid sub_lang');

  const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;
  return {
    format,
    audioOnly: AUDIO.has(format),
    quality,
    formatId,
    subtitles: bool(src.subtitles),
    subLang,
    playlist: bool(src.playlist),
    embedMetadata: src.embed_metadata === undefined ? true : bool(src.embed_metadata),
    embedThumbnail: bool(src.embed_thumbnail),
    sponsorblock: bool(src.sponsorblock),
    limit: Math.max(1, Math.min(parseInt(src.limit, 10) || 5, 50)),
    start: src.start ? String(src.start) : null,
    end: src.end ? String(src.end) : null,
  };
}

const TIME_RE = /^(\d{1,2}:)?\d{1,2}:\d{2}(\.\d+)?$|^\d+(\.\d+)?$/;
function validateSection(o) {
  if (!o.start && !o.end) return null;
  const s = o.start || '0';
  const e = o.end || 'inf';
  if (!TIME_RE.test(s) || (e !== 'inf' && !TIME_RE.test(e))) {
    throw Object.assign(new Error('start/end must be seconds or HH:MM:SS'), { status: 400 });
  }
  return `*${s}-${e}`;
}

/** Build the yt-dlp --format selector and any extra args for a download. */
function buildFormatArgs(o, { forExtract = false } = {}) {
  const h = o.quality && /^\d+$/.test(o.quality) ? o.quality : null;
  const args = [];
  let selector;

  if (o.formatId) {
    selector = o.formatId;
  } else if (o.audioOnly) {
    selector = 'bestaudio/best';
  } else if (o.quality === 'worst') {
    selector = forExtract ? 'worst' : 'worstvideo+worstaudio/worst';
  } else if (h) {
    const ext = o.format === 'webm' ? 'webm' : 'mp4';
    const aext = o.format === 'webm' ? 'webm' : 'm4a';
    selector = forExtract
      ? `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`
      : `bestvideo[height<=${h}][ext=${ext}]+bestaudio[ext=${aext}]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  } else if (o.format === 'webm') {
    selector = 'bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]/best';
  } else {
    selector = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  }
  args.push('--format', selector);

  if (!forExtract) {
    if (o.audioOnly && !o.formatId) {
      const codec = o.format === 'audio' ? 'm4a' : o.format;
      args.push('-x', '--audio-format', codec, '--audio-quality', '0');
    } else if (!o.audioOnly) {
      args.push('--merge-output-format', o.format === 'video' ? 'mp4' : o.format);
    }
  }
  return args;
}

module.exports = { validateUrl, parseOptions, buildFormatArgs, validateSection, isPrivateHost };
