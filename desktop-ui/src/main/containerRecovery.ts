import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export interface ContainerRecoveryPreview {
  title: string;
  detail: string;
}

export type ConfirmContainerRecovery = (preview: ContainerRecoveryPreview) => Promise<boolean>;

const fileSchema = z.object({
  name: z.string().regex(/^(?:ownership\/)?[a-zA-Z0-9.-]+\.json$/),
  before: z.string().nullable(),
  after: z.string(),
});
const transactionSchema = z.object({ files: z.array(fileSchema).min(1) });
const JOURNAL = 'ownership-recovery.json';

export class ContainerOwnershipConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerOwnershipConflict';
  }
}

export function assertNoInterruptedRecovery(directory: string): void {
  if (existsSync(join(directory, JOURNAL))) {
    throw new ContainerOwnershipConflict('An ownership recovery was interrupted. Choose Recover to restore its saved metadata before trying again. Containers and data have not been replaced.');
  }
}

function atomicWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}

function restore(directory: string, files: z.infer<typeof fileSchema>[]): void {
  for (const file of files) {
    const path = join(directory, file.name);
    if (file.before === null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      atomicWrite(path, file.before);
    }
  }
  unlinkSync(join(directory, JOURNAL));
}

export async function restoreInterruptedRecovery(directory: string, confirm: ConfirmContainerRecovery): Promise<boolean> {
  const journal = join(directory, JOURNAL);
  if (!existsSync(journal)) return true;
  const { files } = transactionSchema.parse(JSON.parse(readFileSync(journal, 'utf8')));
  const observed = files.map(file => {
    const current = metadataFile(directory, file.name, file.after).before;
    if (current !== file.before && current !== file.after) {
      throw new Error('Ownership metadata was edited outside the interrupted recovery. Restore it from the saved backup before retrying; no files were changed.');
    }
    return current;
  });
  if (!await confirm({
    title: 'Restore interrupted recovery?',
    detail: 'Restore the ownership metadata saved before the interrupted recovery, then search again. No container, data or credentials will be changed.',
  })) return false;
  if (files.some((file, index) => metadataFile(directory, file.name, file.after).before !== observed[index])) {
    throw new Error('Ownership metadata changed during confirmation. No files were restored.');
  }
  restore(directory, files);
  return true;
}

export function metadataFile(directory: string, name: string, after: string): z.infer<typeof fileSchema> {
  fileSchema.shape.name.parse(name);
  const path = join(directory, name);
  return fileSchema.parse({ name, before: existsSync(path) ? readFileSync(path, 'utf8') : null, after });
}

/** The journal blocks management until every metadata file is committed or restored. */
export function commitRecoveryMetadata(directory: string, files: z.infer<typeof fileSchema>[]): string {
  assertNoInterruptedRecovery(directory);
  const transaction = transactionSchema.parse({ files });
  for (const file of files) {
    const current = metadataFile(directory, file.name, file.after);
    if (current.before !== file.before) throw new Error('Ownership metadata changed during recovery. Search again before approving.');
  }
  const backup = join(directory, 'recovery-backups', `${Date.now()}-${randomUUID()}.json`);
  mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(backup, `${JSON.stringify(transaction)}\n`, { flag: 'wx', mode: 0o600 });
  atomicWrite(join(directory, JOURNAL), `${JSON.stringify(transaction)}\n`);
  try {
    for (const file of files) atomicWrite(join(directory, file.name), file.after);
    unlinkSync(join(directory, JOURNAL));
  } catch (error) {
    try {
      restore(directory, files);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Recovery failed and metadata rollback is incomplete. Management is blocked; choose Recover to restore the saved metadata.');
    }
    throw error;
  }
  return backup;
}

export function sameImageId(actual: string | undefined, expected: string): boolean {
  const normalize = (value: string) => value.replace(/^sha256:/, '').toLowerCase();
  return actual !== undefined && /^[a-fA-F0-9]{64}$/.test(normalize(actual))
    && normalize(actual) === normalize(expected);
}

export function isRawImageId(reference: string): boolean {
  return /^(?:sha256:)?[a-fA-F0-9]{64}$/.test(reference);
}
