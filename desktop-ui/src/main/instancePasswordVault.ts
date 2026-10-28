import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { nativeCredentialStorageAvailable, type NativeCredentialStorage } from './credentialVault';
import { hostTaskOrigin } from './hostTaskBroker';

const legacyCredentialSchema = z.object({
  version: z.literal(1), origin: z.string(), password: z.string().min(1).max(1024),
}).strict();
const credentialSchema = z.object({
  version: z.literal(2), origin: z.string(), value: z.string().min(1).max(4096),
}).strict();

export class NativeInstanceCredentialVault {
  constructor(
    private readonly native: NativeCredentialStorage,
    private readonly platform: NodeJS.Platform,
    private readonly directory: string,
    readonly sharedAcrossBuilds = false,
  ) {}

  available(): boolean { return nativeCredentialStorageAvailable(this.native, this.platform); }

  private requireAvailable(): void {
    if (!this.available()) throw new Error('Native secure storage is unavailable. Sign in without Remember on this device; your password will not be saved.');
  }

  private file(origin: string): string {
    if (hostTaskOrigin(`${origin}/mcp`) !== origin) throw new Error('Invalid remembered instance origin.');
    return join(this.directory, `${createHash('sha256').update(origin).digest('hex')}.bin`);
  }

  async read(origin: string): Promise<string | null> {
    let file;
    try {
      file = await open(this.file(origin), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Cannot read remembered sign-in. Sign in again to replace it, or sign out to forget it.');
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid remembered sign-in file.');
      this.requireAvailable();
      const raw: unknown = JSON.parse(this.native.decryptString(await file.readFile()));
      const legacy = legacyCredentialSchema.safeParse(raw);
      const credential = legacy.success
        ? { origin: legacy.data.origin, value: legacy.data.password }
        : credentialSchema.parse(raw);
      if (credential.origin !== origin) throw new Error('Remembered sign-in belongs to another instance.');
      return credential.value;
    } catch {
      throw new Error('Cannot unlock remembered sign-in using native secure storage. Sign in manually; uncheck Remember on this device to forget the saved password.');
    } finally {
      await file.close();
    }
  }

  async save(origin: string, value: string): Promise<void> {
    this.requireAvailable();
    const credential = credentialSchema.parse({ version: 2, origin, value });
    let encrypted: Buffer;
    try {
      encrypted = this.native.encryptString(JSON.stringify(credential));
    } catch {
      throw new Error('Native secure storage could not save this password. Sign in without Remember on this device; no plaintext fallback is used.');
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(origin), temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(encrypted);
      await file.sync();
      await file.close();
      await rename(temporary, target);
    } catch (error) {
      await file.close();
      await this.remove(temporary);
      throw error;
    }
  }

  async forget(origin: string): Promise<void> { await this.remove(this.file(origin)); }

  private async remove(path: string): Promise<void> {
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export class InstancePasswordVault extends NativeInstanceCredentialVault {
  override save(origin: string, password: string): Promise<void> {
    return super.save(origin, z.string().min(1).max(1024).parse(password));
  }
}
