import { describe, expect, it } from 'vitest';
import { HOST, HOST_ENV, resolveHost } from '../src/config';

describe('control-plane bind host', () => {
  it('binds to loopback by default', () => {
    expect(resolveHost({})).toBe(HOST);
  });

  it('permits the all-interfaces bind required inside a container', () => {
    expect(resolveHost({ [HOST_ENV]: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('rejects arbitrary bind hosts', () => {
    expect(() => resolveHost({ [HOST_ENV]: '192.168.1.10' }))
      .toThrow(`${HOST_ENV} must be`);
  });
});
