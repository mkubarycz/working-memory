import { accessSync, constants } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface DockerHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

function pathDirectories(host: DockerHost): string[] {
  const raw = host.env.PATH ?? host.env.Path ?? '';
  return raw.split(host.platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** Install locations that GUI-launched apps often lack on PATH. */
function extraDockerDirectories(host: DockerHost): string[] {
  const path = pathFor(host.platform);
  if (host.platform === 'win32') {
    const programFiles = host.env.ProgramFiles || 'C:\\Program Files';
    return [path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin')];
  }
  if (host.platform === 'darwin') {
    return [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(host.homedir, '.docker', 'bin'),
      '/Applications/Docker.app/Contents/Resources/bin',
    ];
  }
  return ['/usr/local/bin', '/usr/bin'];
}

export function defaultFileExists(platform: NodeJS.Platform): (candidate: string) => boolean {
  return (candidate) => {
    try {
      accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

export function dockerCliPath(
  host: DockerHost,
  fileExists: (path: string) => boolean = defaultFileExists(host.platform),
): string | undefined {
  const path = pathFor(host.platform);
  const executable = host.platform === 'win32' ? 'docker.exe' : 'docker';
  return [...pathDirectories(host), ...extraDockerDirectories(host)]
    .map((directory) => path.join(directory, executable))
    .find(fileExists);
}

/** Child environment that can find Docker's Compose plugin and credential helpers. */
export function dockerEnvironment(host: DockerHost, dockerPath: string): NodeJS.ProcessEnv {
  const path = pathFor(host.platform);
  const separator = host.platform === 'win32' ? ';' : ':';
  const directories = [...new Set([
    path.dirname(dockerPath),
    ...extraDockerDirectories(host),
    ...pathDirectories(host),
  ])];
  const { Path: _windowsPath, ...env } = host.env;
  return { ...env, PATH: directories.join(separator) };
}
