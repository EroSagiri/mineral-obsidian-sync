// Guarded NODE_OPTIONS preload: maps the bundled ONNX Runtime 1.28.2 by absolute path so that
// sherpa-onnx's by-name import of onnxruntime.dll does not bind to the Windows ML copy in
// C:\Windows\System32\onnxruntime.dll (ONNX Runtime 1.17.1, which only serves API versions <= 17).
//
// Only acts inside the DeepSeek Harness speech worker process; a no-op everywhere else, so it is
// safe to reference from a machine-wide NODE_OPTIONS.
const fs = require('node:fs');
const path = require('node:path');

const execPath = process.execPath ?? '';
const argv = process.argv.join(' ');
const isDshWorker = /DeepSeek Harness/i.test(execPath) && /speech-to-text/i.test(argv);
const isRelevantHost = isDshWorker || process.env.DSH_ORT_PRELOAD_FORCE === '1';

if (isRelevantHost) {
  const bundled = path.join(
    path.dirname(execPath),
    'resources',
    'app.asar.unpacked',
    'dsh',
    'node_modules',
    'sherpa-onnx-win-x64',
    'onnxruntime.dll',
  );
  const shim = process.env.DSH_ORT_PRELOAD_SHIM ?? path.join(__dirname, 'ort-preload.node');
  try {
    if (fs.existsSync(bundled) && fs.existsSync(shim)) {
      process.env.DSH_ORT_PRELOAD = bundled;
      process.dlopen({ exports: {} }, shim);
      console.error(`[ort-preload] mapped bundled ONNX Runtime from ${bundled}`);
    }
  } catch (error) {
    console.error('[ort-preload] failed:', error && error.message);
  }
}
