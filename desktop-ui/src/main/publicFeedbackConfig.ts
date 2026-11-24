import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validatePublicFeedbackConfiguration, type PublicFeedbackConfiguration } from '../../../shared/publicFeedback';
import type { DesktopCredentialVault } from './credentialVault';
import type { PublicFeedbackSettings } from '../shared/contracts';

export class PublicFeedbackConfigStore {
  constructor(private readonly file: string, private readonly vault: Pick<DesktopCredentialVault, 'store' | 'decrypt'>) {}

  async read(): Promise<PublicFeedbackConfiguration | undefined> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new Error('Public Feedback configuration could not be read. Reconfigure it in Settings > Feedback.', { cause: error });
    }
    const stored: unknown = JSON.parse(text);
    if (!stored || typeof stored !== 'object' || !('encryptedApiKey' in stored) || typeof stored.encryptedApiKey !== 'string') {
      throw new Error('Public Feedback configuration is malformed. Reconfigure it in Settings > Feedback.');
    }
    return validatePublicFeedbackConfiguration(JSON.parse(this.vault.decrypt({
      endpoint: '', model: '', encryptedApiKey: stored.encryptedApiKey,
    })));
  }

  async status(): Promise<PublicFeedbackSettings> {
    const configuration = await this.read();
    return { enabled: !!configuration, destination: configuration ? new URL(configuration.uploadUrl).origin
      + new URL(configuration.uploadUrl).pathname : null };
  }

  async save(input: unknown): Promise<PublicFeedbackSettings> {
    const configuration = validatePublicFeedbackConfiguration(input);
    const stored = this.vault.store({ endpoint: '', model: '' }, JSON.stringify(configuration));
    if (!stored.encryptedApiKey) throw new Error('Public Feedback credentials could not be protected; configuration was not saved.');
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ encryptedApiKey: stored.encryptedApiKey }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    }
    return this.status();
  }

  async clear(): Promise<PublicFeedbackSettings> {
    try { await unlink(this.file); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    return { enabled: false, destination: null };
  }
}
