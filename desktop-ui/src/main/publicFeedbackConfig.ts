import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFeedbackResponse, validatePublicFeedbackConfiguration, type PublicFeedbackConfiguration } from '../../../shared/publicFeedback';
import type { DesktopCredentialVault } from './credentialVault';
import type { PublicFeedbackSettings } from '../shared/contracts';

export const FEEDBACK_SERVICE = 'https://wm-feedback-inbox-mk.azurewebsites.net/api';
interface Device {
  id: string;
  token: string;
  proof: string;
  name: string;
}
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class PublicFeedbackConfigStore {
  private operation: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly vault: Pick<DesktopCredentialVault, 'store' | 'decrypt'>,
    private readonly fetcher: typeof fetch = fetch) {}

  private async device(): Promise<Device | undefined> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new Error('Feedback device configuration could not be read.', { cause: error });
    }
    const stored: unknown = JSON.parse(text);
    if (isRecord(stored) && stored.version === undefined && typeof stored.encryptedApiKey === 'string') return undefined;
    if (!isRecord(stored) || stored.version !== 2 || typeof stored.encryptedApiKey !== 'string') {
      throw new Error('Feedback device configuration is malformed. Restore its protected configuration or contact the owner to revoke this device.');
    }
    const device: unknown = JSON.parse(this.vault.decrypt({ endpoint: '', model: '', encryptedApiKey: stored.encryptedApiKey }));
    if (!isRecord(device) || typeof device.id !== 'string' || !UUID.test(device.id)
      || typeof device.token !== 'string' || !SECRET.test(device.token) || typeof device.proof !== 'string' || !SECRET.test(device.proof)
      || typeof device.name !== 'string') throw new Error('Feedback device configuration is malformed. Restore its protected configuration or contact the owner to revoke this device.');
    return { id: device.id, token: device.token, proof: device.proof, name: device.name };
  }

  private async call(path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${FEEDBACK_SERVICE}/${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
        signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (cause) { throw new Error('Feedback service is unreachable. Check your internet connection and retry.', { cause }); }
    if (!response.ok) throw new Error(`Feedback service request failed (HTTP ${response.status}). ${response.status === 429 ? 'Please wait before retrying.' : 'No connection or upload is confirmed.'}`);
    return readFeedbackResponse(response);
  }

  private async deviceStatus(device: Device): Promise<PublicFeedbackSettings> {
    const response = await this.call('devices/status', { id: device.id, proof: device.proof });
    if (!isRecord(response)) throw new Error('Invalid Feedback device status.');
    const state = response.state;
    if (state !== 'pending' && state !== 'connected' && state !== 'revoked' && state !== 'expired') throw new Error('Invalid Feedback device status.');
    if (state === 'pending') {
      if (typeof response.pairingCode !== 'string' || !/^[A-F0-9]{12}$/.test(response.pairingCode)
        || typeof response.expiresAt !== 'string' || !Number.isFinite(Date.parse(response.expiresAt))) throw new Error('Invalid Feedback pairing response.');
      return { enabled: false, state, destination: FEEDBACK_SERVICE, pairingCode: response.pairingCode, expiresAt: response.expiresAt };
    }
    return { enabled: state === 'connected', state, destination: FEEDBACK_SERVICE };
  }

  async status(): Promise<PublicFeedbackSettings> {
    const device = await this.device();
    return device ? this.deviceStatus(device) : { enabled: false, state: 'disconnected', destination: FEEDBACK_SERVICE };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  connect(): Promise<PublicFeedbackSettings> {
    return this.serialize(async () => {
      let device = await this.device();
      if (device) {
        const status = await this.deviceStatus(device);
        if (status.state === 'connected' || status.state === 'pending') return status;
      }
      device = { id: randomUUID(), token: randomBytes(32).toString('base64url'), proof: randomBytes(32).toString('base64url'),
        name: hostname().slice(0, 80) };
      const stored = this.vault.store({ endpoint: '', model: '' }, JSON.stringify(device));
      if (!stored.encryptedApiKey) throw new Error('Feedback device credentials could not be protected; connection was not started.');
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 2, encryptedApiKey: stored.encryptedApiKey }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } finally {
        await unlink(temporary).catch(error => {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        });
      }
      await this.call('devices/register', device);
      return this.deviceStatus(device);
    });
  }

  async read(): Promise<PublicFeedbackConfiguration> {
    const device = await this.device();
    if (!device || !(await this.deviceStatus(device)).enabled) throw new Error('Connect this computer in Settings > Feedback and ask the owner to approve it.');
    const configuration = validatePublicFeedbackConfiguration(await this.call('configuration'));
    if (configuration.uploadUrl !== `${FEEDBACK_SERVICE}/reports`) throw new Error('Feedback configuration points outside the approved service.');
    return { ...configuration, deviceId: device.id, deviceToken: device.token };
  }

  clear(): Promise<PublicFeedbackSettings> {
    return this.serialize(async () => {
      const device = await this.device();
      if (device) await this.call('devices/disconnect', { id: device.id, proof: device.proof });
      try { await unlink(this.file); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      return { enabled: false, state: 'disconnected', destination: FEEDBACK_SERVICE };
    });
  }
}
