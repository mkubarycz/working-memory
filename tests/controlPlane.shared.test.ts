import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  renderWm2Chatmode,
  parsePortInfo,
  resolveControlPlaneHome,
  controlPlanePortFilePath,
  resolveHostingMode,
  resolveControlPlaneStoreHome,
  controlPlaneHealthUrl,
} from '../src/controlPlaneShared';

describe('controlPlaneShared', () => {
  describe('renderWm2Chatmode', () => {
    const md = renderWm2Chatmode();

    it('opens with frontmatter granting the control-plane document tools', () => {
      expect(md.startsWith('---\n')).toBe(true);
      expect(md).toContain('description:');
      expect(md).toContain(
        "tools: ['wm-ping', 'wm-document-create', 'wm-document-read', 'wm-document-update', 'wm-document-delete', 'wm-list-kinds', 'ws-workstream-create', 'ws-workstream-read', 'ws-workstream-update', 'ws-workstream-delete', 'ws-topic-create', 'ws-topic-read', 'ws-topic-update', 'ws-topic-delete', 'ws-topic-attach-workstream', 'ws-topic-detach-workstream', 'ws-topictype-create', 'ws-topictype-read', 'ws-topictype-update', 'ws-topictype-delete', 'ws-alert-create', 'ws-alert-read', 'ws-alert-update', 'ws-alert-delete', 'ws-journalentry-create', 'ws-journalentry-read', 'ws-journalentry-update', 'ws-journalentry-delete']",
      );
    });

    it('describes the wm2 persona and names the tools in the body', () => {
      expect(md).toContain('You are wm2');
      expect(md).toContain('wm-document-read');
      expect(md).toContain('wm-document-create');
      expect(md).toContain('wm-document-update');
      expect(md).toContain('wm-document-delete');
      expect(md).toContain('ws-workstream-create');
      expect(md).toContain('ws-workstream-read');
      expect(md).toContain('ws-workstream-update');
      expect(md).toContain('ws-workstream-delete');
      expect(md).toContain('ws-topic-create');
      expect(md).toContain('ws-topic-read');
      expect(md).toContain('ws-topic-update');
      expect(md).toContain('ws-topic-delete');
      expect(md).toContain('ws-topic-attach-workstream');
      expect(md).toContain('ws-topic-detach-workstream');
      expect(md).toContain('ws-topictype-create');
      expect(md).toContain('ws-topictype-read');
      expect(md).toContain('ws-topictype-update');
      expect(md).toContain('ws-topictype-delete');
      expect(md).toContain('ws-alert-create');
      expect(md).toContain('ws-alert-read');
      expect(md).toContain('ws-alert-update');
      expect(md).toContain('ws-alert-delete');
      expect(md).toContain('ws-journalentry-create');
      expect(md).toContain('ws-journalentry-read');
      expect(md).toContain('ws-journalentry-update');
      expect(md).toContain('ws-journalentry-delete');
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

  describe('resolveHostingMode', () => {
    it('honors the env override above the setting', () => {
      expect(resolveHostingMode({ envValue: 'embedded', settingValue: 'service' })).toBe(
        'embedded',
      );
      expect(resolveHostingMode({ envValue: 'SERVICE', settingValue: 'auto' })).toBe('service');
      expect(resolveHostingMode({ envValue: '  Auto  ', settingValue: 'embedded' })).toBe('auto');
    });

    it('falls back to the setting when the env is absent or unrecognized', () => {
      expect(resolveHostingMode({ settingValue: 'service' })).toBe('service');
      expect(resolveHostingMode({ envValue: '', settingValue: 'embedded' })).toBe('embedded');
      expect(resolveHostingMode({ envValue: 'bogus', settingValue: 'service' })).toBe('service');
    });

    it('defaults to auto when neither layer resolves to a valid mode', () => {
      expect(resolveHostingMode({})).toBe('auto');
      expect(resolveHostingMode({ envValue: 'nope', settingValue: 'also-nope' })).toBe('auto');
      expect(resolveHostingMode({ envValue: null, settingValue: null })).toBe('auto');
    });
  });

  describe('resolveControlPlaneStoreHome', () => {
    const homeEnv = (env: NodeJS.ProcessEnv = {}) => ({
      platform: 'linux' as NodeJS.Platform,
      env,
      homedir: '/home/x',
    });

    it('prefers the WM_CONTROL_PLANE_HOME env override above everything', () => {
      expect(
        resolveControlPlaneStoreHome({
          homeEnv: homeEnv({ WM_CONTROL_PLANE_HOME: '/tmp/cp' }),
          settingPath: '/some/setting',
        }),
      ).toBe(path.resolve('/tmp/cp'));
    });

    it('uses the setting path when the env is unset and the setting is non-empty', () => {
      expect(
        resolveControlPlaneStoreHome({ homeEnv: homeEnv(), settingPath: '/opt/wm' }),
      ).toBe(path.resolve('/opt/wm'));
    });

    it('falls back to the per-OS default when env and setting are both empty', () => {
      expect(resolveControlPlaneStoreHome({ homeEnv: homeEnv(), settingPath: '' })).toBe(
        path.join('/home/x', '.local', 'share', 'working-memory'),
      );
      expect(resolveControlPlaneStoreHome({ homeEnv: homeEnv(), settingPath: '   ' })).toBe(
        path.join('/home/x', '.local', 'share', 'working-memory'),
      );
      expect(resolveControlPlaneStoreHome({ homeEnv: homeEnv() })).toBe(
        path.join('/home/x', '.local', 'share', 'working-memory'),
      );
    });
  });

  describe('controlPlaneHealthUrl', () => {
    it('builds a loopback /health URL for the given port', () => {
      expect(controlPlaneHealthUrl(7717)).toBe('http://127.0.0.1:7717/health');
      expect(controlPlaneHealthUrl(0)).toBe('http://127.0.0.1:0/health');
    });
  });
});
