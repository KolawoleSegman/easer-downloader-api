'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.YTDLP_PATH = path.join(__dirname, 'fake-ytdlp.js');
process.env.TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'easer-test-'));
process.env.MAX_CONCURRENT = '1';
process.env.MAX_QUEUE = '1';
process.env.DOWNLOAD_TIMEOUT_MS = '15000';

const assert = require('assert');
const dl = require('../lib/downloader');
const yt = require('../lib/ytdlp');
const { parseOptions } = require('../lib/validate');

let n = 0;
const t = async (name, fn) => {
  try {
    await fn();
    n++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name, '\n   ', e.stack || e.message || e);
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  dl.init();

  await t('version', async () => {
    const v = await yt.version({ force: true });
    assert.strictEqual(v.value, '2099.01.01-fake');
    assert.strictEqual(v.ok, true);
  });

  await t('single download + progress events', async () => {
    const seen = [];
    const r = await dl.download('https://example.com/v', parseOptions({}), {
      onProgress: (p) => seen.push(p),
    });
    assert.strictEqual(r.zip, false);
    assert.strictEqual(r.filename, 'Fake Title 1.mp4');
    assert(seen.some((p) => p.status === 'downloading' && p.progress >= 49));
    assert(seen.some((p) => p.speed === '1.00MiB/s'));
    dl.rmDir(r.dir);
  });

  await t('audio produces mp3', async () => {
    const r = await dl.download('https://example.com/v', parseOptions({ format: 'mp3' }));
    assert.strictEqual(r.filename.endsWith('.mp3'), true);
    dl.rmDir(r.dir);
  });

  await t('playlist is zipped with playlist title and overall progress', async () => {
    let max = 0;
    const r = await dl.download(
      'https://example.com/p',
      parseOptions({ playlist: true, limit: 3 }),
      { onProgress: (p) => { max = Math.max(max, p.progress); } },
    );
    assert.strictEqual(r.zip, true);
    assert.strictEqual(r.filename, 'My Mix.zip');
    assert.strictEqual(r.files.length, 3);
    assert(max > 60 && max <= 98, 'progress ' + max);
    dl.rmDir(r.dir);
  });

  await t('subtitles + media become a zip', async () => {
    const r = await dl.download('https://example.com/v', parseOptions({ subtitles: true }));
    assert.strictEqual(r.zip, true);
    assert(r.files.some((f) => f.ext === 'srt'));
    dl.rmDir(r.dir);
  });

  await t('failure is classified and temp dir removed', async () => {
    const before = fs.readdirSync(process.env.TEMP_DIR).length;
    try {
      await dl.download('https://example.com/fail-private', parseOptions({}));
      assert.fail('should throw');
    } catch (e) {
      const h = yt.toHttpError(e, 'Download failed');
      assert.strictEqual(h.status, 403);
      assert.strictEqual(h.code, 'PRIVATE');
    }
    assert.strictEqual(fs.readdirSync(process.env.TEMP_DIR).length, before);
  });

  await t('abort kills the process', async () => {
    const ac = new AbortController();
    const p = dl.download('https://example.com/hang', parseOptions({}), { signal: ac.signal });
    await sleep(300);
    ac.abort();
    await assert.rejects(p, (e) => e.code === 'ABORTED');
    // Give the queue a tick to release
    await sleep(50);
    assert.strictEqual(dl.queue.active, 0);
  });

  await t('queue limits: 1 running + 1 waiting, third rejected with 503', async () => {
    const a = new AbortController();
    const first = dl.download('https://example.com/hang', parseOptions({}), { signal: a.signal }).catch((e) => e);
    await sleep(200);
    const b = new AbortController();
    const second = dl.download('https://example.com/v', parseOptions({}), { signal: b.signal }).catch((e) => e);
    await sleep(100);
    await assert.rejects(
      dl.download('https://example.com/v', parseOptions({})),
      (e) => e.status === 503 && e.code === 'BUSY',
    );
    a.abort();
    const firstResult = await first;
    assert(firstResult && firstResult.code === 'ABORTED');
    const r = await second;
    assert(r && r.filename, 'second job should complete after first aborts');
    dl.rmDir(r.dir);
  });

  await t('job lifecycle + SSE listener', async () => {
    const job = dl.createJob('https://example.com/v', parseOptions({}));
    const events = [];
    job.listeners.add((j) => events.push(j.status));
    dl.startJob(job);
    for (let i = 0; i < 50 && job.status !== 'completed' && job.status !== 'failed'; i++) {
      await sleep(100);
    }
    assert.strictEqual(job.status, 'completed');
    assert(events.includes('downloading'));
    assert(fs.existsSync(job.dir));
    dl.deleteJob(job);
    await sleep(100);
    assert(!fs.existsSync(job.dir));
  });

  await t('job cancel', async () => {
    const job = dl.createJob('https://example.com/hang', parseOptions({}));
    dl.startJob(job);
    await sleep(300);
    assert(dl.cancelJob(job));
    await sleep(150);
    assert.strictEqual(job.status, 'cancelled');
    assert.strictEqual(dl.queue.active, 0);
  });

  await t('sanitize strips credentials', () => {
    assert(!yt.sanitize('proxy http://user:secret@h:1').includes('secret'));
  });

  console.log(`\n${n} passed`);
  dl.shutdown();
  // Force exit so hanging intervals from failed tests cannot keep the process alive
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('Fatal test runner error:', e);
  try { dl.shutdown(); } catch { /* ignore */ }
  process.exit(1);
});
