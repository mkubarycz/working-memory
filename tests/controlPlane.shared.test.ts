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
  controlPlaneMcpUrl,
  coercePort,
  parseListeningPort,
  resolveServicePort,
} from '../src/controlPlaneShared';

describe('controlPlaneShared', () => {
  describe('renderWm2Chatmode', () => {
    const md = renderWm2Chatmode();

    it('opens with frontmatter granting the control-plane document tools', () => {
      expect(md.startsWith('---\n')).toBe(true);
      expect(md).toContain('description:');
      expect(md).toContain(
        "tools: ['wm-ping', 'wm-document-create', 'wm-document-read', 'wm-document-update', 'wm-document-delete', 'wm-list-kinds', 'ws-workstream-create', 'ws-workstream-read', 'ws-workstream-update', 'ws-workstream-delete', 'ws-topic-create', 'ws-topic-read', 'ws-topic-update', 'ws-topic-delete', 'ws-topictype-create', 'ws-topictype-read', 'ws-topictype-update', 'ws-topictype-delete', 'ws-alert-create', 'ws-alert-read', 'ws-alert-update', 'ws-alert-delete']",
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
      expect(md).toContain('ws-topictype-create');
      expect(md).toContain('ws-topictype-read');
      expect(md).toContain('ws-topictype-update');
      expect(md).toContain('ws-topictype-delete');
      expect(md).toContain('ws-alert-create');
      expect(md).toContain('ws-alert-read');
      expect(md).toContain('ws-alert-update');
      expect(md).toContain('ws-alert-delete');
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

    it('honors the env override when allowEnvOverride is true (Development)', () => {
      expect(
        resolveControlPlaneHome({
          platform: 'linux',
          env: { WM_CONTROL_PLANE_HOME: '/tmp/wm-cp' },
          homedir: '/home/x',
          allowEnvOverride: true,
        }),
      ).toBe(path.resolve('/tmp/wm-cp'));
    });

    it('IGNORES the env override when allowEnvOverride is false (Production)', () => {
      expect(
        resolveControlPlaneHome({
          platform: 'linux',
          env: { WM_CONTROL_PLANE_HOME: '/tmp/wm-cp' },
          homedir: '/home/x',
          allowEnvOverride: false,
        }),
      ).toBe(path.join('/home/x', '.local', 'share', 'working-memory'));
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

    it('honors the env override when allowEnvOverride is true (Development)', () => {
      expect(
        resolveHostingMode({ envValue: 'embedded', settingValue: 'service', allowEnvOverride: true }),
      ).toBe('embedded');
    });

    it('IGNORES the env override when allowEnvOverride is false (Production)', () => {
      expect(
        resolveHostingMode({
          envValue: 'embedded',
          settingValue: 'service',
          allowEnvOverride: false,
        }),
      ).toBe('service');
      expect(resolveHostingMode({ envValue: 'embedded', allowEnvOverride: false })).toBe('auto');
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

    it('honors the env override when the homeEnv allows it (Development)', () => {
      expect(
        resolveControlPlaneStoreHome({
          homeEnv: { ...homeEnv({ WM_CONTROL_PLANE_HOME: '/tmp/cp' }), allowEnvOverride: true },
          settingPath: '/some/setting',
        }),
      ).toBe(path.resolve('/tmp/cp'));
    });

    it('IGNORES the env override and uses the setting when the homeEnv disallows it (Production)', () => {
      expect(
        resolveControlPlaneStoreHome({
          homeEnv: { ...homeEnv({ WM_CONTROL_PLANE_HOME: '/tmp/cp' }), allowEnvOverride: false },
          settingPath: '/some/setting',
        }),
      ).toBe(path.resolve('/some/setting'));
    });

    it('IGNORES the env override and falls back to the per-OS default in Production with no setting', () => {
      expect(
        resolveControlPlaneStoreHome({
          homeEnv: { ...homeEnv({ WM_CONTROL_PLANE_HOME: '/tmp/cp' }), allowEnvOverride: false },
          settingPath: '',
        }),
      ).toBe(path.join('/home/x', '.local', 'share', 'working-memory'));
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

  describe('controlPlaneMcpUrl', () => {
    it('builds a loopback /mcp URL for the given port', () => {
      expect(controlPlaneMcpUrl(7717)).toBe('http://127.0.0.1:7717/mcp');
      expect(controlPlaneMcpUrl(54321)).toBe('http://127.0.0.1:54321/mcp');
    });
  });

  describe('coercePort', () => {
    it('accepts valid numbers and numeric strings', () => {
      expect(coercePort(7717)).toBe(7717);
      expect(coercePort('7717')).toBe(7717);
      expect(coercePort('  8080  ')).toBe(8080);
      expect(coercePort(65535)).toBe(65535);
      expect(coercePort(1)).toBe(1);
    });

    it('rejects 0, out-of-range, non-numeric, and empty values', () => {
      // 0 is a valid ephemeral BIND request but never a valid endpoint to reach.
      expect(coercePort(0)).toBeNull();
      expect(coercePort('0')).toBeNull();
      expect(coercePort(70000)).toBeNull();
      expect(coercePort(-1)).toBeNull();
      expect(coercePort('abc')).toBeNull();
      expect(coercePort('')).toBeNull();
      expect(coercePort('   ')).toBeNull();
      expect(coercePort(null)).toBeNull();
      expect(coercePort(undefined)).toBeNull();
      expect(coercePort(3.5)).toBeNull();
    });
  });

  describe('parseListeningPort', () => {
    it('parses the daemon LISTENING marker line', () => {
      expect(parseListeningPort('WM_CONTROL_PLANE_LISTENING 54123\n')).toBe(54123);
    });

    it('finds the marker amid surrounding log noise / concatenated chunks', () => {
      const buf =
        '[control-plane] registered kinds: Topic\n' +
        'WM_CONTROL_PLANE_LISTENING 60007\n' +
        '[control-plane] home: /tmp\n';
      expect(parseListeningPort(buf)).toBe(60007);
    });

    it('returns null when the marker is absent or the port is invalid', () => {
      expect(parseListeningPort('nothing here')).toBeNull();
      expect(parseListeningPort('WM_CONTROL_PLANE_LISTENING')).toBeNull();
      expect(parseListeningPort('WM_CONTROL_PLANE_LISTENING abc')).toBeNull();
      expect(parseListeningPort('WM_CONTROL_PLANE_LISTENING 70000')).toBeNull();
      expect(parseListeningPort('WM_CONTROL_PLANE_LISTENING 0')).toBeNull();
    });
  });

  describe('resolveServicePort', () => {
    it('prefers the env override above the setting (Development)', () => {
      expect(
        resolveServicePort({ envValue: '9001', settingValue: 8080, allowEnvOverride: true }),
      ).toBe(9001);
    });

    it('IGNORES the env override in Production and uses the setting', () => {
      expect(
        resolveServicePort({ envValue: '9001', settingValue: 8080, allowEnvOverride: false }),
      ).toBe(8080);
    });

    it('falls back to the setting when the env is absent/invalid', () => {
      expect(resolveServicePort({ settingValue: 8080 })).toBe(8080);
      expect(resolveServicePort({ envValue: '', settingValue: 8080, allowEnvOverride: true })).toBe(
        8080,
      );
      expect(
        resolveServicePort({ envValue: 'bogus', settingValue: 8080, allowEnvOverride: true }),
      ).toBe(8080);
    });

    it('falls back to the well-known default (7717) when nothing resolves', () => {
      expect(resolveServicePort({})).toBe(7717);
      expect(resolveServicePort({ envValue: null, settingValue: null })).toBe(7717);
      expect(resolveServicePort({ settingValue: 0 })).toBe(7717);
      expect(resolveServicePort({ envValue: '0', settingValue: 70000, allowEnvOverride: true })).toBe(
        7717,
      );
    });
  });
});
