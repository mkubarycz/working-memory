import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  renderWm2Chatmode,
  parsePortInfo,
  resolveControlPlaneHome,
  controlPlanePortFilePath,
} from '../src/controlPlaneShared';

describe('controlPlaneShared', () => {
  describe('renderWm2Chatmode', () => {
    const md = renderWm2Chatmode();

    it('opens with frontmatter granting the control-plane document tools', () => {
      expect(md.startsWith('---\n')).toBe(true);
      expect(md).toContain('description:');
      expect(md).toContain(
        "tools: ['wm_ping', 'wm_create_document', 'wm_list_documents', 'wm_get_document']",
      );
    });

    it('describes the wm2 persona and names the tools in the body', () => {
      expect(md).toContain('You are wm2');
      expect(md).toContain('wm_list_documents');
      expect(md).toContain('wm_create_document');
      expect(md).toContain('wm_get_document');
    });
  });

  describe('parsePortInfo', () => {
    it('parses a valid { port, pid } payload', () => {
      expect(parsePortInfo(JSON.stringify({ port: 7717, pid: 1234 }))).toEqual({
        port: 7717,
        pid: 1234,
      });
    });

    it('returns null for missing, malformed, or out-of-range input', () => {
      expect(parsePortInfo(null)).toBeNull();
      expect(parsePortInfo('')).toBeNull();
      expect(parsePortInfo('not json')).toBeNull();
      expect(parsePortInfo(JSON.stringify([1, 2]))).toBeNull();
      expect(parsePortInfo(JSON.stringify({ port: 0, pid: 1 }))).toBeNull();
      expect(parsePortInfo(JSON.stringify({ port: 70000, pid: 1 }))).toBeNull();
      expect(parsePortInfo(JSON.stringify({ port: 7717 }))).toBeNull();
      expect(parsePortInfo(JSON.stringify({ port: 7717, pid: -1 }))).toBeNull();
    });
  });

  describe('resolveControlPlaneHome + controlPlanePortFilePath', () => {
    it('honors the WM_CONTROL_PLANE_HOME override and derives the port file path', () => {
      const home = resolveControlPlaneHome({
        platform: 'linux',
        env: { WM_CONTROL_PLANE_HOME: '/tmp/wm-cp' },
        homedir: '/home/x',
      });
      expect(home).toBe(path.resolve('/tmp/wm-cp'));
      expect(controlPlanePortFilePath(home)).toBe(
        path.join('/tmp/wm-cp', 'run', 'control-plane.port.json'),
      );
    });

    it('resolves per-OS defaults', () => {
      expect(
        resolveControlPlaneHome({ platform: 'darwin', env: {}, homedir: '/Users/x' }),
      ).toBe(path.join('/Users/x', 'Library', 'Application Support', 'WorkingMemory'));

      expect(
        resolveControlPlaneHome({ platform: 'linux', env: {}, homedir: '/home/x' }),
      ).toBe(path.join('/home/x', '.local', 'share', 'working-memory'));

      expect(
        resolveControlPlaneHome({
          platform: 'linux',
          env: { XDG_DATA_HOME: '/data' },
          homedir: '/home/x',
        }),
      ).toBe(path.join('/data', 'working-memory'));

      expect(
        resolveControlPlaneHome({
          platform: 'win32',
          env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' },
          homedir: 'C:/Users/x',
        }),
      ).toBe(path.join('C:/Users/x/AppData/Local', 'WorkingMemory'));
    });
  });
});
