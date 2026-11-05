import { readFile, writeFile } from 'node:fs/promises';
import { parseContainerProvider, type ContainerProvider } from './containerProvider';

export async function readContainerProvider(file: string): Promise<ContainerProvider> {
  try {
    return parseContainerProvider(JSON.parse(await readFile(file, 'utf8')).provider);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'docker';
    throw new Error(`Unable to read the container provider setting. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeContainerProvider(file: string, value: unknown): Promise<ContainerProvider> {
  const provider = parseContainerProvider(value);
  await writeFile(file, `${JSON.stringify({ provider })}\n`, { mode: 0o600 });
  return provider;
}
