import type { ConnectionResult } from '../shared/contracts';
import type { StoredConfig } from './config';

export async function checkConfiguredModel(
  config: StoredConfig,
  probe: (config: StoredConfig) => Promise<string>,
): Promise<ConnectionResult> {
  if (!config.model.trim()) {
    return { ok: false, message: 'Choose a model first.' };
  }
  try {
    return { ok: true, message: await probe(config) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
