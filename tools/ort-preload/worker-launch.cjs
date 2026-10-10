// Launch one managed process with an explicit argv array (so paths containing spaces survive) and
// inherited stdio. Used by verify.ps1 to run the DSH speech worker exactly the way its host does.
//
//   node worker-launch.cjs <spec.json>
//
// spec.json: { exe, worker, config, cwd, stripNodeOptions? }
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node worker-launch.cjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SPEECH_TOKEN: 'a'.repeat(64) };
if (spec.stripNodeOptions) delete env.NODE_OPTIONS;

console.log(`exe     : ${spec.exe}`);
console.log(`worker  : ${spec.worker}`);
console.log(`NODE_OPT : ${env.NODE_OPTIONS ?? '(unset)'}`);

const child = spawn(spec.exe, [spec.worker, JSON.stringify(spec.config)], {
  cwd: spec.cwd ?? process.cwd(),
  stdio: 'inherit',
  env,
  windowsHide: true,
});

child.on('error', (error) => {
  console.error('spawn failed:', error.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  console.log(`worker exited: code=${code} signal=${signal ?? '-'}`);
  process.exit(code ?? 1);
});
