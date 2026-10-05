import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAC_APP_IDENTIFIER,
  macCodeSignArguments,
} from './macos-code-signing.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'desktop-ui');
const electronRoot = join(desktopRoot, 'node_modules', 'electron');
const sourceDist = join(electronRoot, 'dist');
const pathFile = join(electronRoot, 'path.txt');
const runtimeRoot = join(desktopRoot, 'runtime');
const targetPlatform = process.env.WM_DESKTOP_PLATFORM || process.platform;
const targetArch = process.env.WM_DESKTOP_ARCH || process.arch;
const expectedExecutables = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
  win32: 'electron.exe',
};

function materializeSymlinks(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      const target = realpathSync(path);
      const targetStats = statSync(target);
      rmSync(path, { recursive: true, force: true });
      cpSync(target, path, {
        recursive: targetStats.isDirectory(),
        dereference: true,
        preserveTimestamps: true,
      });
      chmodSync(path, targetStats.mode);
    }
    if (statSync(path).isDirectory()) {
      materializeSymlinks(path);
    }
  }
}

if (!existsSync(sourceDist) || !existsSync(pathFile)) {
  throw new Error('Electron is not installed in desktop-ui; run npm install there first.');
}

const executable = readFileSync(pathFile, 'utf8').trim();
if (!executable) {
  throw new Error('Electron path.txt is empty.');
}
const normalizedExecutable = executable.split(sep).join('/');
const expectedExecutable = expectedExecutables[targetPlatform];
if (!expectedExecutable || normalizedExecutable !== expectedExecutable) {
  throw new Error(
    `Installed Electron executable ${normalizedExecutable} does not match target platform ${targetPlatform}.`,
  );
}

const sourceExecutable = resolve(sourceDist, executable);
const sourceRelative = relative(sourceDist, sourceExecutable);
if (sourceRelative.startsWith('..') || !existsSync(sourceExecutable)) {
  throw new Error(`Electron executable is invalid: ${executable}`);
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });
cpSync(sourceDist, join(runtimeRoot, 'electron'), {
  recursive: true,
  preserveTimestamps: true,
  verbatimSymlinks: true,
});
if (targetPlatform !== 'darwin') {
  materializeSymlinks(join(runtimeRoot, 'electron'));
}

function prepareMacApp(appBundle, deepSign) {
  const contents = join(appBundle, 'Contents');
  const infoPath = join(contents, 'Info.plist');
  let info = readFileSync(infoPath, 'utf8');
  const replacePlistString = (key, value) => {
    const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (!pattern.test(info)) {
      throw new Error(`Electron Info.plist is missing ${key}`);
    }
    info = info.replace(pattern, `$1${value}$2`);
  };
  replacePlistString('CFBundleIdentifier', MAC_APP_IDENTIFIER);
  replacePlistString('CFBundleName', 'Working Memory');
  replacePlistString('CFBundleDisplayName', 'Working Memory');
  if (!info.includes('<key>NSCameraUsageDescription</key>')) {
    info = info.replace(
      '</dict>\n</plist>',
      [
        '\t<key>NSCameraUsageDescription</key>',
        '\t<string>Working Memory uses the camera to attach photos to chat prompts and topics.</string>',
        '</dict>',
        '</plist>',
      ].join('\n'),
    );
  }
  if (!info.includes('<key>CFBundleURLTypes</key>')) {
    info = info.replace(
      '</dict>\n</plist>',
      [
        '\t<key>CFBundleURLTypes</key>',
        '\t<array>',
        '\t\t<dict>',
        '\t\t\t<key>CFBundleURLName</key>',
        '\t\t\t<string>Working Memory</string>',
        '\t\t\t<key>CFBundleURLSchemes</key>',
        '\t\t\t<array>',
        '\t\t\t\t<string>working-memory</string>',
        '\t\t\t</array>',
        '\t\t</dict>',
        '\t</array>',
        '</dict>',
        '</plist>',
      ].join('\n'),
    );
  }
  writeFileSync(infoPath, info);

  const appResources = join(contents, 'Resources', 'app');
  mkdirSync(appResources, { recursive: true });
  cpSync(join(desktopRoot, 'out'), join(appResources, 'out'), {
    recursive: true,
    preserveTimestamps: true,
  });
  writeFileSync(
    join(appResources, 'package.json'),
    `${JSON.stringify({
      name: 'working-memory-desktop',
      productName: 'Working Memory',
      type: 'module',
      main: 'out/main/index.js',
    }, null, 2)}\n`,
  );

  if (process.platform === 'darwin') {
    const signingRoot = mkdtempSync(join(tmpdir(), 'working-memory-sign-'));
    const signingBundle = join(signingRoot, 'Working Memory.app');
    cpSync(appBundle, signingBundle, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    let signingError = '';
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const clearedAttributes = spawnSync(
          '/usr/bin/xattr',
          ['-cr', signingBundle],
          { encoding: 'utf8' },
        );
        if (clearedAttributes.status !== 0) {
          throw new Error(
            `Unable to clear Working Memory.app metadata: ${clearedAttributes.stderr || clearedAttributes.stdout}`,
          );
        }
        for (const attribute of ['com.apple.FinderInfo', 'com.apple.fileprovider.fpfs#P']) {
          const removedAttribute = spawnSync(
            '/usr/bin/xattr',
            ['-dr', attribute, signingBundle],
            { encoding: 'utf8' },
          );
          if (removedAttribute.status !== 0) {
            throw new Error(
              `Unable to remove ${attribute} from Working Memory.app: ${removedAttribute.stderr || removedAttribute.stdout}`,
            );
          }
        }
        const signed = spawnSync(
          '/usr/bin/codesign',
          macCodeSignArguments(signingBundle, { deep: deepSign }),
          { encoding: 'utf8' },
        );
        if (signed.status === 0) {
          rmSync(appBundle, { recursive: true, force: true });
          cpSync(signingBundle, appBundle, {
            recursive: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
          return;
        }
        signingError = signed.stderr || signed.stdout;
        console.warn(
          `prepare-desktop-runtime: signing attempt ${attempt} failed after metadata cleanup`,
        );
      }
      throw new Error(`Unable to sign Working Memory.app after 3 attempts: ${signingError}`);
    } finally {
      rmSync(signingRoot, { recursive: true, force: true });
    }
  }
}

if (targetPlatform === 'darwin') {
  prepareMacApp(join(runtimeRoot, 'electron', 'Electron.app'), false);

  const applicationRoot = join(runtimeRoot, 'application');
  const applicationBundle = join(applicationRoot, 'Working Memory.app');
  mkdirSync(applicationRoot, { recursive: true });
  cpSync(join(sourceDist, 'Electron.app'), applicationBundle, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  prepareMacApp(applicationBundle, true);
}

writeFileSync(
  join(runtimeRoot, 'launch.json'),
  `${JSON.stringify(
    {
      platform: targetPlatform,
      arch: targetArch,
      electron: `electron/${normalizedExecutable}`,
    },
    null,
    2,
  )}\n`,
);
