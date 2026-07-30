/**
 * The nanite execution-provider registry — a small id → {@link NaniteRunner}
 * map with a configured default. A Nanite Template's `executionSettings` names
 * an execution provider; the dispatch site resolves that name here to pick the
 * concrete runner. Unknown or absent provider falls back to the default (the
 * extension-host runner for now).
 */

import type { NaniteRunner } from './types';

export class NaniteRunnerRegistry {
  private readonly runners = new Map<string, NaniteRunner>();

  constructor(private readonly defaultId: string) {}

  /** Register a runner under its own `id`. */
  register(runner: NaniteRunner): void {
    this.runners.set(runner.id, runner);
  }

  /**
   * Resolve a runner by provider id, falling back to the default when the id is
   * absent or unregistered. Throws only if the default itself was never
   * registered (a wiring bug).
   */
  resolve(providerId?: string | null): NaniteRunner {
    if (providerId && this.runners.has(providerId)) {
      return this.runners.get(providerId)!;
    }
    const fallback = this.runners.get(this.defaultId);
    if (!fallback) {
      throw new Error(
        `no default nanite runner registered (id '${this.defaultId}')`,
      );
    }
    return fallback;
  }
}

/** Read `executionSettings.provider` defensively (absent / foreign → null). */
export function providerFromSettings(
  settings: Record<string, unknown> | undefined,
): string | null {
  const provider = settings?.provider;
  return typeof provider === 'string' && provider.trim() ? provider : null;
}
