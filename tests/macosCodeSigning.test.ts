import { describe, expect, it } from 'vitest';
import {
  MAC_AD_HOC_DESIGNATED_REQUIREMENT,
  MAC_APP_IDENTIFIER,
  MAC_LOCAL_CODESIGN_IDENTITY,
  macCodeSignArguments,
  resolveMacCodeSignIdentity,
} from '../scripts/macos-code-signing.mjs';

describe('macOS desktop code signing', () => {
  it('keeps the bundle identifier stable for ad-hoc builds', () => {
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

  it('prefers an Apple Development certificate with a stable Team ID over the local certificate', () => {
    const fingerprint = 'A'.repeat(40);
    expect(resolveMacCodeSignIdentity({
      platform: 'darwin',
      findIdentities: () => ({
        status: 0,
        stdout: `1) ${'B'.repeat(40)} "${MAC_LOCAL_CODESIGN_IDENTITY}"\n2) ${fingerprint} "Apple Development: Example (TEAM123456)"\n2 valid identities found`,
        stderr: '',
      }),
    })).toBe(fingerprint);
    expect(macCodeSignArguments('/tmp/Working Memory.app', { deep: true, identity: fingerprint }))
      .toEqual(['--force', '--deep', '--sign', fingerprint, '/tmp/Working Memory.app']);
  });

  it('recognizes legacy Mac Developer certificates', () => {
    const fingerprint = 'C'.repeat(40);
    expect(resolveMacCodeSignIdentity({
      platform: 'darwin',
      findIdentities: () => ({
        status: 0, stdout: `1) ${fingerprint} "Mac Developer: Example (TEAM123456)"`, stderr: '',
      }),
    })).toBe(fingerprint);
  });

  it('requires an explicit choice instead of silently switching between development identities', () => {
    expect(() => resolveMacCodeSignIdentity({
      platform: 'darwin',
      findIdentities: () => ({
        status: 0,
        stdout: `1) ${'A'.repeat(40)} "Apple Development: First (TEAM123456)"\n2) ${'B'.repeat(40)} "Apple Development: Second (TEAM654321)"`,
        stderr: '',
      }),
    })).toThrow('WM_DESKTOP_CODESIGN_IDENTITY');
  });

  it('honors explicit distribution or development identities without looking up another signer', () => {
    expect(resolveMacCodeSignIdentity({
      configuredIdentity: 'Developer ID Application: Example',
      platform: 'darwin',
      findIdentities: () => { throw new Error('Unexpected identity lookup'); },
    })).toBe('Developer ID Application: Example');
  });

  it('surfaces Keychain lookup failures instead of silently falling back to ad-hoc signing', () => {
    expect(() => resolveMacCodeSignIdentity({
      platform: 'darwin',
      findIdentities: () => ({ status: 1, stdout: '', stderr: 'Keychain is unavailable' }),
    })).toThrow('Keychain is unavailable');
  });

  it('does not inspect macOS Keychain on other platforms', () => {
    expect(resolveMacCodeSignIdentity({
      platform: 'linux',
      findIdentities: () => { throw new Error('Unexpected identity lookup'); },
    })).toBe('-');
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
