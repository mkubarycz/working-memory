import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEmbeddingModel } from '../src/main/embeddingRuntime';

const paths: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
it('rejects unverified downloads, removes partial files and preserves the previous artifact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wm-embedding-verification-'));
  paths.push(directory);
  writeFileSync(join(directory, 'tokenizer.json'), 'previous artifact');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('corrupt download')));
  await expect(installEmbeddingModel(directory, new AbortController().signal, () => {})).rejects.toThrow('verification failed');
  expect(existsSync(join(directory, 'tokenizer.json.part'))).toBe(false);
  expect(readFileSync(join(directory, 'tokenizer.json'), 'utf8')).toBe('previous artifact');
});
it('does not start a download after cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wm-embedding-cancel-'));
  paths.push(directory);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  controller.abort(new Error('Paused'));
  await expect(installEmbeddingModel(directory, controller.signal, () => {})).rejects.toThrow('Paused');
  expect(fetch).not.toHaveBeenCalled();
});
