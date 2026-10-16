'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateUrl, parseOptions, buildFormatArgs, validateSection } = require('../lib/validate');
const { createLimiter } = require('../lib/ratelimit');
const { writeZip, zipSize } = require('../lib/zip');

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };

(async () => {
  console.log('validate');
  await t('accepts https', () => assert.strictEqual(validateUrl('https://youtu.be/abc'), 'https://youtu.be/abc'));
  await t('rejects option injection', () => assert.throws(() => validateUrl('--exec rm -rf /'), /Invalid URL/));
  await t('rejects file://', () => assert.throws(() => validateUrl('file:///etc/passwd'), /http/));
  await t('rejects localhost', () => assert.throws(() => validateUrl('http://localhost:5000/'), /Private/));
  await t('rejects 10.x', () => assert.throws(() => validateUrl('http://10.0.0.5/x'), /Private/));
  await t('rejects 169.254 metadata', () => assert.throws(() => validateUrl('http://169.254.169.254/'), /Private/));
  await t('rejects ipv6 loopback', () => assert.throws(() => validateUrl('http://[::1]/'), /Private/));
  await t('rejects non-string', () => assert.throws(() => validateUrl({}), /required/));

  console.log('options');
  await t('defaults', () => { const o = parseOptions({}); assert.strictEqual(o.format, 'video'); assert.strictEqual(o.audioOnly, false); });
  await t('bad format', () => assert.throws(() => parseOptions({ format: 'exe' }), /Unsupported/));
  await t('quality 720p normalised', () => assert.strictEqual(parseOptions({ quality: '720p' }).quality, '720'));
  await t('bad quality', () => assert.throws(() => parseOptions({ quality: 'x;rm' }), /quality/));
  await t('format_id injection', () => assert.throws(() => parseOptions({ format_id: '--exec foo' }), /Invalid format_id/));
  await t('format_id ok', () => assert.strictEqual(parseOptions({ format_id: 'bv*[height<=720]+ba/b' }).formatId, 'bv*[height<=720]+ba/b'));
  await t('limit clamp', () => assert.strictEqual(parseOptions({ limit: 999 }).limit, 50));

  console.log('format args');
  await t('mp3', () => { const a = buildFormatArgs(parseOptions({ format: 'mp3' })); assert(a.includes('-x') && a.includes('mp3')); });
  await t('720 video', () => { const a = buildFormatArgs(parseOptions({ quality: 720 })); assert(a[1].includes('height<=720')); });
  await t('extract has no merge args', () => { const a = buildFormatArgs(parseOptions({}), { forExtract: true }); assert(!a.includes('--merge-output-format')); });
  await t('section', () => assert.strictEqual(validateSection({ start: '0:30', end: '1:00' }), '*0:30-1:00'));
  await t('bad section', () => assert.throws(() => validateSection({ start: '$(x)' }), /start\/end/));

  console.log('rate limit');
  await t('blocks after max, recovers', () => {
    const l = createLimiter({ windowMs: 1000, max: 2 });
    assert(l.check('a', 0).ok); assert(l.check('a', 10).ok);
    const r = l.check('a', 20); assert(!r.ok && r.retryAfter >= 1);
    assert(l.check('b', 20).ok);
    assert(l.check('a', 1100).ok);
  });

  console.log('zip');
  await t('produces a valid archive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-'));
    const files = [];
    for (const [name, content] of [['a é.txt', 'hello world'], ['b.bin', crypto_bytes(300000)], ['empty.txt', '']]) {
      const p = path.join(dir, 'f' + files.length); fs.writeFileSync(p, content); files.push({ path: p, name });
    }
    const out = path.join(dir, 'out.zip');
    const ws = fs.createWriteStream(out);
    await writeZip(files, ws);
    await new Promise(r => ws.on('close', r));
    assert.strictEqual(fs.statSync(out).size, zipSize(files));
    execFileSync('unzip', ['-tq', out]);
    execFileSync('unzip', ['-qo', out, '-d', path.join(dir, 'x')]);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'x', 'a é.txt'), 'utf8'), 'hello world');
    assert(fs.readFileSync(path.join(dir, 'x', 'b.bin')).equals(fs.readFileSync(files[1].path)));
  });
  console.log(`\n${n} passed`);
})();
function crypto_bytes(k) { return require('crypto').randomBytes(k); }
