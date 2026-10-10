// Extract every entry under a directory prefix from an asar archive into a destination directory.
import fs from 'node:fs';
import path from 'node:path';

const [asarPath, prefix, dest] = process.argv.slice(2);
if (!asarPath || !prefix || !dest) {
  console.error('usage: node asar-extract-dir.mjs <app.asar> <dir/in/asar> <destDir>');
  process.exit(2);
}

const fd = fs.openSync(asarPath, 'r');
const sz = Buffer.alloc(8);
fs.readSync(fd, sz, 0, 8, 0);
const headerSize = sz.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const jsonSize = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonSize).replace(/\0+$/, ''));
const base = 8 + headerSize;
fs.closeSync(fd);

const entries = [];
(function walk(node, p) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const q = p ? `${p}/${name}` : name;
    if (child.files) walk(child, q);
    else entries.push({ path: q, offset: Number(child.offset), size: child.size, unpacked: Boolean(child.unpacked) });
  }
})(header, '');

const wanted = entries.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`));
if (wanted.length === 0) {
  console.error(`no entries under ${prefix}`);
  process.exit(1);
}
const raw = fs.readFileSync(asarPath);
let written = 0;
for (const e of wanted) {
  if (e.unpacked) {
    console.log(`skip (unpacked on disk): ${e.path}`);
    continue;
  }
  const target = path.join(dest, e.path.slice(prefix.length).replace(/^\//, ''));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw.subarray(base + e.offset, base + e.offset + e.size));
  written++;
}
console.log(`extracted ${written}/${wanted.length} entries -> ${dest}`);
