// Print printable string context around every occurrence of a byte pattern in a binary file.
import fs from 'node:fs';

const [file, pattern, spanArg = '1500'] = process.argv.slice(2);
const span = Number(spanArg);
const buf = fs.readFileSync(file);
const needle = Buffer.from(pattern, 'utf8');
const start = buf.indexOf(needle);
if (start === -1) {
  console.log('no match');
  process.exit(1);
}
const from = Math.max(0, start - span);
const to = Math.min(buf.length, start + needle.length + span);
let run = '';
for (let i = from; i < to; i++) {
  const c = buf[i];
  if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
  else {
    if (run.length >= 6) console.log(`${i - run.length}\t${run}`);
    run = '';
  }
}
if (run.length >= 6) console.log(`${to - run.length}\t${run}`);
