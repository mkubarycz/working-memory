import { describe, expect, it } from 'vitest';
import {
  MAC_AD_HOC_DESIGNATED_REQUIREMENT,
  MAC_APP_IDENTIFIER,
  MAC_LOCAL_CODESIGN_IDENTITY,
  macCodeSignArguments,
  resolveMacCodeSignIdentity,
} from '../scripts/macos-code-signing.mjs';

describe('macOS desktop code signing', () => {
  it('uses a stable designated requirement for local ad-hoc builds', () => {
    expect(macCodeSignArguments('/tmp/Working Memory.app', {
      identity: '-',
    })).toEqual([
      '--force',
      '--sign',
      '-',
      '--identifier',
      MAC_APP_IDENTIFIER,
      '--requirements',
      MAC_AD_HOC_DESIGNATED_REQUIREMENT,
      '/tmp/Working Memory.app',
    ]);
  });

  it('preserves certificate-backed designated requirements for distribution builds', () => {
    expect(macCodeSignArguments('/tmp/Working Memory.app', {
      deep: true,
      identity: 'Developer ID Application: Example',
    })).toEqual([
      '--force',
      '--deep',
      '--sign',
      'Developer ID Application: Example',
      '/tmp/Working Memory.app',
    ]);
  });

  it('uses the reusable local certificate when it is installed', () => {
    expect(resolveMacCodeSignIdentity({
      platform: 'darwin',
      findIdentities: () => ({
        status: 0,
        stdout: `1) ABC123 "${MAC_LOCAL_CODESIGN_IDENTITY}"`,
        stderr: '',
      }),
    })).toBe(MAC_LOCAL_CODESIGN_IDENTITY);
  });

  it('falls back to ad-hoc signing when the local certificate is unavailable', () => {
    expect(resolveMacCodeSignIdentity({
      platform: 'darwin',
      findIdentities: () => ({
        status: 0,
        stdout: '0 valid identities found',
        stderr: '',
      }),
    })).toBe('-');
  });
});
