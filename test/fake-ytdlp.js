#!/usr/bin/env node
// Minimal stand-in for yt-dlp used by the tests.
const fs = require('fs');
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const url = sep >= 0 ? args[sep + 1] : '';
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
if (args.includes('--version')) { console.log('2099.01.01-fake'); process.exit(0); }
if (url.includes('fail-private')) { console.error('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access'); process.exit(1); }
if (url.includes('hang')) { setInterval(() => {}, 1000); return; }
const out = val('-o');
if (out) {
  const playlist = args.includes('--yes-playlist');
  const n = playlist ? +val('--playlist-end') : 1;
  const audio = args.includes('-x');
  if (playlist) console.log('[download] Downloading playlist: My Mix');
  for (let i = 1; i <= n; i++) {
    if (playlist) console.log(`[download] Downloading item ${i} of ${n}`);
    for (const p of [10, 50, 100]) console.log(`[download]  ${p}.0% of 1.00MiB at 1.00MiB/s ETA 00:0${3 - (p / 50 | 0)}`);
    if (audio) console.log('[ExtractAudio] Destination: x');
    const name = out.replace('%(playlist_index)03d', String(i).padStart(3, '0')).replace(/%\(title\)\.\d+B/, 'Fake Title ' + i).replace('%(ext)s', audio ? val('--audio-format') : 'mp4');
    fs.writeFileSync(name, Buffer.alloc(2048, i));
    if (args.includes('--write-subs')) fs.writeFileSync(name.replace(/\.\w+$/, '.en.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
  }
  process.exit(0);
}
process.exit(0);
