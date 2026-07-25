import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPortFile, writePortFile, removePortFile } from '../src/portfile';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-cp-port-'));
  file = path.join(dir, 'control-plane.port.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('port file round-trip', () => {
  it('writes and reads back { port, pid }', () => {
    writePortFile(file, { port: 7717, pid: process.pid });
    expect(readPortFile(file)).toEqual({ port: 7717, pid: process.pid });
  });

  it('persists valid JSON on disk', () => {
    writePortFile(file, { port: 40100, pid: 4242 });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({ port: 40100, pid: 4242 });
  });

  it('creates the runtime directory if missing', () => {
    const nested = path.join(dir, 'run', 'control-plane.port.json');
    writePortFile(nested, { port: 7717, pid: 1 });
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('port file validation', () => {
  it('returns null when the file is missing', () => {
    expect(readPortFile(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    fs.writeFileSync(file, '{ not valid json');
    expect(readPortFile(file)).toBeNull();
  });

  it('returns null for the wrong shape', () => {
    fs.writeFileSync(file, JSON.stringify({ port: 'x', pid: 1 }));
    expect(readPortFile(file)).toBeNull();
  });

  it('returns null for out-of-range ports', () => {
    fs.writeFileSync(file, JSON.stringify({ port: 70000, pid: 1 }));
    expect(readPortFile(file)).toBeNull();
  });

  it('rejects invalid ports/pids on write', () => {
    expect(() => writePortFile(file, { port: 0, pid: 1 })).toThrow();
    expect(() => writePortFile(file, { port: 99999, pid: 1 })).toThrow();
    expect(() => writePortFile(file, { port: 7717, pid: 0 })).toThrow();
  });
});

describe('removePortFile', () => {
  it('deletes the file and is idempotent', () => {
    writePortFile(file, { port: 7717, pid: 1 });
    removePortFile(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removePortFile(file)).not.toThrow();
  });
});
