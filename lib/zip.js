'use strict';
// Minimal streaming ZIP writer (STORE method – media is already compressed).
// No dependencies. Files must be < 4 GiB each (enforced via MAX_FILESIZE).
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32File(file) {
  return new Promise((resolve, reject) => {
    let crc = 0xFFFFFFFF;
    fs.createReadStream(file)
      .on('data', (buf) => { for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); })
      .on('end', () => resolve((crc ^ 0xFFFFFFFF) >>> 0))
      .on('error', reject);
  });
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Streams `files` ([{path, name}]) as a zip into writable `out`. */
async function writeZip(files, out) {
  const entries = [];
  let offset = 0;
  const write = (buf) => new Promise((resolve, reject) => {
    offset += buf.length;
    if (out.write(buf)) return resolve();
    out.once('drain', resolve);
    out.once('error', reject);
  });

  for (const f of files) {
    const st = fs.statSync(f.path);
    if (st.size >= 0xFFFFFFFF) throw new Error(`File too large for zip: ${f.name}`);
    const crc = await crc32File(f.path);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const { time, date } = dosDateTime(st.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);           // UTF-8 names
    local.writeUInt16LE(0, 8);                // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(st.size, 18);
    local.writeUInt32LE(st.size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    entries.push({ nameBuf, crc, size: st.size, offset, time, date });
    await write(local);
    await write(nameBuf);
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(f.path);
      rs.on('data', (chunk) => { offset += chunk.length; if (!out.write(chunk)) { rs.pause(); out.once('drain', () => rs.resume()); } });
      rs.on('end', resolve);
      rs.on('error', reject);
      out.once('error', reject);
    });
  }

  const cdStart = offset;
  for (const e of entries) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(e.time, 12);
    c.writeUInt16LE(e.date, 14);
    c.writeUInt32LE(e.crc, 16);
    c.writeUInt32LE(e.size, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(e.nameBuf.length, 28);
    c.writeUInt32LE(e.offset, 42);
    await write(c);
    await write(e.nameBuf);
  }
  const cdSize = offset - cdStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
}

/** Compute the exact zip size up-front so we can send Content-Length. */
function zipSize(files) {
  let total = 22;
  for (const f of files) {
    const n = Buffer.byteLength(f.name, 'utf8');
    total += 30 + n + fs.statSync(f.path).size + 46 + n;
  }
  return total;
}

module.exports = { writeZip, zipSize, crc32File, path };
