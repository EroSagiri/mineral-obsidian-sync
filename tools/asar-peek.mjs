// Minimal asar inspector.
//   node asar-peek.mjs <app.asar> --list <regex>        list entries matching a regex
//   node asar-peek.mjs <app.asar> <needle> [--dump|--window=N]
import fs from 'node:fs';

const [asarPath, needle, opts = ''] = process.argv.slice(2);
if (!asarPath || !needle) {
  console.error('usage: node asar-peek.mjs <app.asar> (--list <regex> | <needle> [--dump|--window=N])');
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

const entries = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p);
    else entries.push({ path: p, offset: Number(child.offset), size: child.size, unpacked: Boolean(child.unpacked), link: child.link });
  }
})(header, '');
fs.closeSync(fd);

if (needle === '--list') {
  const re = new RegExp(opts, 'i');
  const hits = entries.filter((e) => re.test(e.path));
  console.log(`entries=${entries.length} matches=${hits.length}`);
  for (const e of hits) console.log(`  ${e.path} size=${e.size} unpacked=${e.unpacked} link=${e.link ?? '-'}`);
  process.exit(0);
}

const raw = fs.readFileSync(asarPath);

if (needle === '--extract') {
  const wanted = entries.filter((e) => e.path === opts.replace(/\\/g, '/'));
  if (wanted.length === 0) {
    console.error(`not found: ${opts}`);
    process.exit(1);
  }
  for (const e of wanted) {
    if (e.unpacked) {
      console.log(`// ${e.path} is stored unpacked on disk (size=${e.size})`);
      process.exit(0);
    }
    process.stdout.write(raw.subarray(base + e.offset, base + e.offset + e.size));
  }
  process.exit(0);
}

const needleBuf = Buffer.from(needle, 'utf8');
const hits = [];
let at = raw.indexOf(needleBuf);
while (at !== -1 && hits.length < 50) {
  hits.push(at);
  at = raw.indexOf(needleBuf, at + 1);
}
console.log(`entries=${entries.length} rawHits=${hits.length}`);
for (const hit of hits) {
  const e = entries.find((x) => base + x.offset <= hit && hit < base + x.offset + x.size);
  console.log(`offset=${hit} entry=${e ? `${e.path} (+${hit - base - e.offset} of ${e.size})` : '<none>'}`);
  if (e && opts === '--dump') {
    const out = `tools/out-${e.path.replace(/[\\/@]/g, '__')}`;
    fs.writeFileSync(out, raw.subarray(base + e.offset, base + e.offset + e.size));
    console.log(`  dumped -> ${out}`);
  } else if (e && opts.startsWith('--window=')) {
    const w = Number(opts.slice(9));
    const s = hit - base - e.offset;
    console.log(raw.subarray(base + e.offset, base + e.offset + e.size).toString('utf8', Math.max(0, s - w), s + w));
  }
}
