import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'native', 'embeddings', 'helper.py');
const requirements = join(root, 'native', 'embeddings', 'requirements.txt');
const output = join(root, 'desktop-ui', 'build', 'embeddings');
const executable = join(output, 'wm-embeddings', process.platform === 'win32' ? 'wm-embeddings.exe' : 'wm-embeddings');
const stamp = join(output, 'build-stamp');
const fingerprint = createHash('sha256').update(readFileSync(source)).update(readFileSync(requirements))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(`${process.platform}:${process.arch}`).digest('hex');
if (existsSync(executable) && existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint) {
  console.log('Bundled embedding runtime is current.');
  process.exit(0);
}
const directory = join(root, '.tools', 'embedding-runtime');
const python = join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Embedding runtime build failed: ${result.error?.message ?? `${command} exited ${result.status}`}`);
}
if (!existsSync(python)) {
  run(process.env.WM_EMBEDDING_PYTHON || (process.platform === 'win32' ? 'python' : 'python3.13'), ['-m', 'venv', directory]);
}
const check = spawnSync(python, ['-c',
  `import numpy, tokenizers, psutil, PyInstaller, ${process.platform === 'win32' ? 'openvino' : 'onnxruntime'}`]);
const requirementsStamp = join(directory, 'requirements-stamp');
const requirementsHash = createHash('sha256').update(readFileSync(requirements)).digest('hex');
if (check.status !== 0 || !existsSync(requirementsStamp) || readFileSync(requirementsStamp, 'utf8') !== requirementsHash) {
  run(python, ['-m', 'pip', 'install', '-r', requirements]);
  writeFileSync(requirementsStamp, requirementsHash);
}
mkdirSync(output, { recursive: true });
run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'wm-embeddings',
  '--distpath', output, '--workpath', join(root, '.tools', 'embedding-build'),
  '--specpath', join(root, '.tools'), '--collect-all', process.platform === 'win32' ? 'openvino' : 'onnxruntime',
  '--exclude-module', process.platform === 'win32' ? 'onnxruntime' : 'openvino', source]);
writeFileSync(stamp, fingerprint);
