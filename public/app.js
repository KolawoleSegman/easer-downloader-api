'use strict';
const $ = (id) => document.getElementById(id);
const statusEl = $('status'), progressWrap = $('progressWrap'), progressBar = $('progressBar');
let apiKey = sessionStorage.getItem('easer_key') || '';

// ---------- helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}
const setStatus = (m, type = '') => { statusEl.textContent = m || ''; statusEl.className = type; };
const fmtDur = (s) => { if (s == null) return '?'; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtSize = (b) => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
const fmtCount = (n) => n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M views' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K views' : n + ' views';
const showProgress = (pct) => { progressWrap.classList.add('show'); progressBar.style.width = pct + '%'; };
const hideProgress = () => setTimeout(() => progressWrap.classList.remove('show'), 1200);

async function api(path, { method = 'GET', body, raw = false, quiet = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401) { if (!quiet) switchTab('settings'); throw new Error('API key required — enter it in Settings.'); }
    const err = new Error(e.suggestion || e.details || e.message || e.error || res.statusText);
    err.retryAfter = e.retryAfter; throw err;
  }
  return raw ? res : res.json();
}
const withKey = (path) => apiKey ? path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(apiKey) : path;

async function saveBlob(res, fallback) {
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') || '';
  const m = disp.match(/filename\*=UTF-8''([^;]+)/i) || disp.match(/filename="?([^";]+)"?/i);
  const a = el('a', { href: URL.createObjectURL(blob), download: m ? decodeURIComponent(m[1]) : fallback });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---------- tabs ----------
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  for (const p of ['download', 'search', 'queue', 'settings']) $('panel-' + p).hidden = p !== name;
  if (name === 'queue') refreshJobs();
  if (name === 'settings') loadServerInfo();
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

// ---------- request body ----------
const urls = () => $('url').value.split(/\s+/).map(s => s.trim()).filter(Boolean);
function opts() {
  const b = { format: $('format').value };
  if ($('quality').value) b.quality = $('quality').value;
  if ($('subs').checked) { b.subtitles = true; b.sub_lang = $('subLang').value || 'en.*,en'; }
  if ($('playlist').checked) { b.playlist = true; b.limit = +$('plLimit').value || 5; }
  if ($('thumbEmbed').checked) b.embed_thumbnail = true;
  if ($('sponsor').checked) b.sponsorblock = true;
  if ($('start').value.trim()) b.start = $('start').value.trim();
  if ($('end').value.trim()) b.end = $('end').value.trim();
  if ($('formatId').value.trim()) b.format_id = $('formatId').value.trim();
  return b;
}
function oneUrl() {
  const u = urls()[0];
  if (!u) { setStatus('Enter a URL', 'err'); return null; }
  return u;
}
function busy(btn, on) { document.querySelectorAll('.btns button').forEach(b => b.disabled = on); }

// ---------- info ----------
$('btnInfo').onclick = async () => {
  const url = oneUrl(); if (!url) return;
  setStatus('Fetching info…'); busy(null, true);
  try {
    const d = await api('/api/info', { method: 'POST', body: { url, playlist: $('playlist').checked, limit: +$('plLimit').value || 10 } });
    $('preview').hidden = false; $('links').hidden = true;
    $('pQualities').replaceChildren(); $('fmtList').replaceChildren();
    if (d.type === 'playlist') {
      $('pThumb').src = d.entries[0]?.thumbnail || '';
      $('pTitle').textContent = d.playlist_title || 'Playlist';
      $('pMeta').textContent = `${d.count} items`;
      $('fmtWrap').hidden = true;
    } else {
      $('pThumb').src = d.thumbnail || '';
      $('pTitle').textContent = d.title || '—';
      $('pMeta').textContent = [d.uploader, fmtDur(d.duration), d.extractor, fmtCount(d.view_count), d.is_live ? 'LIVE' : ''].filter(Boolean).join(' · ');
      for (const h of d.available_heights || []) {
        $('pQualities').append(el('button', { class: 'chip', text: h + 'p', onclick: () => { ensureOption('quality', String(h)); $('quality').value = String(h); $('format').value = 'video'; $('formatId').value = ''; } }));
      }
      if (d.audio_available) $('pQualities').append(el('button', { class: 'chip', text: 'audio only', onclick: () => { $('format').value = 'mp3'; } }));
      const f = d.formats || [];
      $('fmtWrap').hidden = !f.length;
      $('fmtList').replaceChildren(...f.slice().reverse().map(x => el('div', { class: 'fmt', onclick: () => { $('formatId').value = x.format_id; document.querySelector('#panel-download details').open = true; } },
        el('span', { text: `${x.format_id} · ${x.ext} · ${x.resolution || (x.has_video ? '' : 'audio')}${x.fps ? ' ' + x.fps + 'fps' : ''}` }),
        el('span', { class: 'muted', text: fmtSize(x.filesize) }))));
    }
    setStatus(d.cached ? 'Info loaded (cached)' : 'Info loaded', 'ok');
  } catch (e) { setStatus(e.message, 'err'); } finally { busy(null, false); }
};
function ensureOption(id, value) {
  const s = $(id); if (![...s.options].some(o => o.value === value)) s.append(el('option', { value, text: `≤ ${value}p` }));
}

// ---------- extract ----------
$('btnExtract').onclick = async () => {
  const url = oneUrl(); if (!url) return;
  setStatus('Extracting direct links…'); busy(null, true);
  try {
    const d = await api('/api/extract', { method: 'POST', body: { url, ...opts() } });
    const box = $('links'); box.hidden = false; box.replaceChildren(el('div', { class: 'muted', text: d.note }));
    d.streams.forEach(s => box.append(el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: `${s.type}${s.height ? ' ' + s.height + 'p' : ''} · ${s.ext || ''} ${fmtSize(s.filesize)}` })));
    setStatus(`${d.streams.length} link(s) ready`, 'ok');
  } catch (e) { setStatus(e.message, 'err'); } finally { busy(null, false); }
};

// ---------- thumbnail / subtitles ----------
async function fileAction(path, body, fallback, label) {
  setStatus(label); busy(null, true);
  try { await saveBlob(await api(path, { method: 'POST', body, raw: true }), fallback); setStatus('Saved', 'ok'); }
  catch (e) { setStatus(e.message, 'err'); } finally { busy(null, false); }
}
$('btnThumb').onclick = () => { const url = oneUrl(); if (url) fileAction('/api/thumbnail', { url }, 'thumbnail.jpg', 'Fetching thumbnail…'); };
$('btnSubs').onclick = () => { const url = oneUrl(); if (url) fileAction('/api/subtitles', { url, lang: $('subLang').value || 'en.*,en' }, 'subtitles.srt', 'Fetching subtitles…'); };

// ---------- direct download ----------
$('btnDl').onclick = async () => {
  const url = oneUrl(); if (!url) return;
  setStatus('Downloading… long videos can take a while. Use “Add to queue” for big files.'); showProgress(12); busy(null, true);
  try {
    const res = await api('/api/download', { method: 'POST', body: { url, ...opts() }, raw: true });
    showProgress(90); await saveBlob(res, 'download'); showProgress(100); setStatus('Download started!', 'ok');
  } catch (e) { setStatus(e.message, 'err'); } finally { busy(null, false); hideProgress(); }
};

// ---------- queue / jobs ----------
$('btnJob').onclick = async () => {
  const list = urls(); if (!list.length) return setStatus('Enter a URL', 'err');
  busy(null, true);
  try {
    if (list.length === 1) await api('/api/job/download', { method: 'POST', body: { url: list[0], ...opts() } });
    else {
      const d = await api('/api/job/batch', { method: 'POST', body: { urls: list, ...opts() } });
      const bad = d.jobs.filter(j => j.error).length;
      if (bad) setStatus(`${d.jobs.length - bad} queued, ${bad} rejected`, 'err');
    }
    setStatus('Added to queue', 'ok'); switchTab('queue');
  } catch (e) { setStatus(e.message, 'err'); } finally { busy(null, false); }
};

let jobTimer = null;
async function refreshJobs() {
  try {
    const { jobs } = await api('/api/jobs', { quiet: true });
    const active = jobs.filter(j => ['queued', 'downloading', 'processing'].includes(j.status)).length;
    $('qcount').hidden = !active; $('qcount').textContent = active;
    const box = $('jobList');
    box.replaceChildren(...(jobs.length ? jobs.map(jobRow) : [el('p', { class: 'muted', text: 'No downloads yet.' })]));
    clearTimeout(jobTimer);
    if (active || !$('panel-queue').hidden) jobTimer = setTimeout(refreshJobs, active ? 1500 : 5000);
  } catch (e) { clearTimeout(jobTimer); }
}
function jobRow(j) {
  const meta = [j.status, j.status === 'downloading' ? `${Math.round(j.progress)}%` : '', j.speed, j.eta ? 'ETA ' + j.eta : '', j.item && j.total > 1 ? `item ${j.item}/${j.total}` : ''].filter(Boolean).join(' · ');
  const row = el('div', { class: 'item' },
    el('div', { class: 't', text: j.result?.fileName || j.url }),
    el('div', { class: 'm', text: j.status === 'failed' ? (j.suggestion || j.error || 'Failed') : meta }));
  if (['downloading', 'processing', 'queued'].includes(j.status)) row.append(el('div', { class: 'mini' }, el('div', { style: `width:${j.progress || 2}%` })));
  const acts = el('div', { class: 'm' });
  if (j.status === 'completed') acts.append(el('a', { href: withKey(j.result.download_path), text: `Save (${fmtSize(j.result.size)})` }));
  acts.append(el('button', { class: 'lnk', text: ['completed', 'failed', 'cancelled'].includes(j.status) ? 'Remove' : 'Cancel', onclick: async () => { await api('/api/job/' + j.id, { method: 'DELETE' }).catch(() => {}); refreshJobs(); } }));
  row.append(acts);
  return row;
}
$('btnClear').onclick = async () => {
  const { jobs } = await api('/api/jobs');
  await Promise.all(jobs.filter(j => ['completed', 'failed', 'cancelled'].includes(j.status)).map(j => api('/api/job/' + j.id, { method: 'DELETE' }).catch(() => {})));
  refreshJobs();
};

// ---------- search ----------
async function doSearch() {
  const query = $('query').value.trim(); if (!query) return;
  const box = $('searchResults'); box.replaceChildren(el('p', { class: 'muted', text: 'Searching…' }));
  try {
    const d = await api('/api/search', { method: 'POST', body: { query, limit: 10, source: $('source').value } });
    box.replaceChildren(...(d.results.length ? d.results.map(r => el('div', { class: 'item click', onclick: () => { $('url').value = r.url || ''; switchTab('download'); setStatus(''); } },
      el('div', { class: 't', text: r.title || '—' }),
      el('div', { class: 'm', text: [r.channel, r.duration ? fmtDur(r.duration) : '', fmtCount(r.view_count)].filter(Boolean).join(' · ') }))) : [el('p', { class: 'muted', text: 'No results' })]));
  } catch (e) { box.replaceChildren(el('p', { class: 'muted', style: 'color:var(--err)', text: e.message })); }
}
$('btnSearch').onclick = doSearch;
$('query').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// ---------- settings / health ----------
$('apiKey').value = apiKey;
$('btnSaveKey').onclick = () => { apiKey = $('apiKey').value.trim(); sessionStorage.setItem('easer_key', apiKey); setStatus('Key saved for this tab', 'ok'); loadServerInfo(); };
async function loadServerInfo() {
  try {
    const [h, s] = await Promise.all([fetch('/health').then(r => r.json()), api('/api/stats').catch(() => null)]);
    $('serverInfo').textContent = [`yt-dlp ${h.yt_dlp?.version}`, `cookies: ${h.cookies ? 'yes' : 'no'}`, `proxy: ${h.proxy ? 'yes' : 'no'}`,
      s ? `downloads: ${s.downloads} · failures: ${s.failures} · active ${s.active}/${s.max_concurrent} · queued ${s.queued}` : 'stats need a valid API key'].join('\n');
  } catch { $('serverInfo').textContent = 'Server unreachable'; }
}
(async () => {
  try { const h = await fetch('/health').then(r => r.json()); $('health').classList.add(h.status === 'healthy' ? 'ok' : 'bad'); $('ver').textContent = 'v' + h.version; }
  catch { $('health').classList.add('bad'); }
  refreshJobs();
})();
// Paste-friendly: clean ?si= style tracking noise is left to yt-dlp; just autosize the box
$('url').addEventListener('input', e => { e.target.rows = Math.min(6, Math.max(2, e.target.value.split('\n').length)); });
