// Populates media/codicons/ with codicon.css + codicon.ttf from the
// @vscode/codicons package. media/codicons/ is a gitignored generated artifact
// that the vsix ships, so this step must run on build/install to guarantee the
// packaged extension includes the icon font (otherwise webview icons break).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'node_modules', '@vscode', 'codicons', 'dist');
const dest = join(root, 'media', 'codicons');

const files = ['codicon.css', 'codicon.ttf'];

mkdirSync(dest, { recursive: true });
for (const file of files) {
  copyFileSync(join(src, file), join(dest, file));
  console.log(`copy-codicons: ${file} -> media/codicons/${file}`);
}
