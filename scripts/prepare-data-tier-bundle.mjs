// Stages the control-plane Docker build context that installers ship as
// resources/data-tier. The desktop app runs `docker compose` against it when
// no healthy Working Memory data tier is running.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(repoRoot, 'desktop-ui', 'build', 'data-tier');

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const file of ['Dockerfile', 'package.json', 'package-lock.json']) {
  cpSync(join(repoRoot, file), join(destination, file));
}
mkdirSync(join(destination, 'control-plane'), { recursive: true });
cpSync(join(repoRoot, 'control-plane', 'tsconfig.json'), join(destination, 'control-plane', 'tsconfig.json'));
cpSync(join(repoRoot, 'control-plane', 'src'), join(destination, 'control-plane', 'src'), { recursive: true });
console.log(`prepare-data-tier-bundle: staged ${destination}`);
