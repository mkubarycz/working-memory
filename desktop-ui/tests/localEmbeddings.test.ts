import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalEmbeddings } from '../src/main/localEmbeddings';
import { EMBEDDING_MODEL, EMBEDDING_DOWNLOAD_BYTES } from '../../control-plane/src/embeddingContract';
import type { EmbeddingDashboard } from '../src/shared/embeddings';

const dashboard: EmbeddingDashboard = { endpoint: null, enabled: false, paused: false, phase: 'disabled', model: EMBEDDING_MODEL,
  configurationKey: 'd'.repeat(64),
  downloadBytes: 0, downloadTotal: EMBEDDING_DOWNLOAD_BYTES, backend: null, warning: null, error: null,
  rssBytes: null, lastInferenceMs: null, lastSuccessAtMs: null, stats: null };
function fixture() {
  let endpoint = 'http://127.0.0.1:7717/mcp';
  const callTool = vi.fn(async (): Promise<{ ok: true; result: EmbeddingDashboard } | { ok: false; error: string }> =>
    ({ ok: true, result: dashboard }));
  const ensure = vi.fn(async () => ({ endpoint: 'http://host.docker.internal:7716', token: 'a'.repeat(64) }));
  let minutes: number | null = null;
  const readSettings = () => ({ idleTimeoutMinutes: minutes });
  const setRetention = vi.fn(async (value: number | null) => { minutes = value; return readSettings(); });
  const usesWslNetworking = vi.fn(() => false);
  const restore = vi.fn(async () => {});
  const current = () => endpoint ? { endpoint, client: { callTool } } : null;
  const service = new LocalEmbeddings(current, { ensure, restore, readSettings, setRetention, usesWslNetworking });
  return { service, callTool, ensure, restore, setRetention, usesWslNetworking, switchTo: (value: string) => { endpoint = value; } };
}
afterEach(() => vi.restoreAllMocks());
describe('desktop background indexing controls', () => {
  it('retains legacy backend controls without performing an unconditional automatic retry', async () => {
    const { service, callTool, ensure, usesWslNetworking } = fixture();
    usesWslNetworking.mockReturnValue(true);
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, configurationKey: undefined,
      enabled: true, phase: 'error', error: 'Host inference service unavailable: connection refused' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await service.snapshot()).toMatchObject({ enabled: true, error: expect.stringContaining('Update the selected backend') });
    expect(ensure).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalledWith('wm-embeddings-configure', expect.anything());
  });
  it('waits for launch and native restoration before repairing the newly selected environment', async () => {
    const { service, callTool, ensure, restore, usesWslNetworking, switchTo } = fixture();
    usesWslNetworking.mockReturnValue(true);
    switchTo('');
    let launch!: () => void;
    let nativeReady!: () => void;
    restore.mockImplementationOnce(() => new Promise<void>(resolve => { nativeReady = resolve; }));
    const pending = service.restore(new Promise<void>(resolve => { launch = resolve; }));
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    switchTo('http://127.0.0.1:7719/mcp');
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, enabled: true, phase: 'error',
      error: 'Host inference service unavailable: connection refused' } });
    launch();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    expect(callTool).not.toHaveBeenCalled();
    nativeReady();
    await pending;
    expect(ensure).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith('wm-embeddings-configure', expect.objectContaining({ action: 'retry' }));
  });
  it('propagates launch failures without prematurely restoring the native service', async () => {
    const { service, restore, callTool } = fixture();
    await expect(service.restore(Promise.reject(new Error('Launch failed')))).rejects.toThrow('Launch failed');
    expect(restore).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
  it('does not check the route before a failed native restoration completes', async () => {
    const { service, restore, callTool } = fixture();
    restore.mockRejectedValueOnce(new Error('Native restoration failed'));
    await expect(service.restore(Promise.resolve())).rejects.toThrow('Native restoration failed');
    expect(callTool).not.toHaveBeenCalled();
  });
  it.each(['setup', 'probe', 'rejection'])('retains fetched controls and redacts an automatic %s repair failure', async failure => {
    const { service, callTool, ensure, usesWslNetworking } = fixture();
    usesWslNetworking.mockReturnValue(true);
    const fetched: EmbeddingDashboard = { ...dashboard, enabled: true, phase: 'error',
      error: 'Host inference service unavailable: connection refused',
      stats: { total: 10, indexed: 2, pending: 8, limited: 0, vectorBytes: 100, lastIndexedAt: null } };
    callTool.mockResolvedValue({ ok: true, result: fetched });
    const token = 'b'.repeat(64);
    const error = new Error(`Route blocked. Bearer ${token}`, { cause: new Error('ECONNREFUSED') });
    if (failure === 'setup') ensure.mockRejectedValueOnce(error);
    else if (failure === 'probe') callTool.mockResolvedValueOnce({ ok: true, result: fetched }).mockRejectedValueOnce(error);
    else callTool.mockResolvedValueOnce({ ok: true, result: fetched })
      .mockResolvedValueOnce({ ok: false, error: `Route blocked. Bearer ${token} Cause: ECONNREFUSED` });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await service.snapshot();
    expect(result).toMatchObject({ enabled: true, paused: false, phase: 'error', stats: fetched.stats,
      error: expect.stringContaining('Automatic WSL route repair failed: Route blocked.') });
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.error).not.toContain(token);
    expect(log).toHaveBeenCalledWith('[embeddings] Automatic WSL route repair failed:', expect.not.stringContaining(token));
    await service.action('pause');
    await service.action('disable');
    expect(callTool).toHaveBeenCalledWith('wm-embeddings-configure', { action: 'pause' });
    expect(callTool).toHaveBeenCalledWith('wm-embeddings-configure', { action: 'disable' });
  });
  it.each(['setup', 'probe'])('rejects a changed environment even when %s repair fails', async failure => {
    const { service, callTool, ensure, usesWslNetworking, switchTo } = fixture();
    usesWslNetworking.mockReturnValue(true);
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, enabled: true, phase: 'error',
      error: 'Host inference service unavailable: connection refused' } });
    const fail = async () => { switchTo('http://127.0.0.1:7719/mcp'); throw new Error('Repair failed'); };
    if (failure === 'setup') ensure.mockImplementationOnce(fail);
    else callTool.mockResolvedValueOnce({ ok: true, result: { ...dashboard, enabled: true, phase: 'error',
      error: 'Host inference service unavailable: connection refused' } }).mockImplementationOnce(fail);
    await expect(service.snapshot()).rejects.toThrow('Selected environment changed');
  });
  it('does not treat native model errors or a remote environment as a local WSL route repair', async () => {
    const { service, callTool, ensure, usesWslNetworking, switchTo } = fixture();
    usesWslNetworking.mockReturnValue(true);
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, enabled: true, phase: 'error',
      endpoint: 'http://172.24.32.1:7716', error: 'OpenVINO initialization failed' } });
    await service.snapshot();
    expect(ensure).not.toHaveBeenCalled();
    switchTo('https://remote.example/mcp');
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, enabled: true, phase: 'error',
      error: 'Host inference service unavailable: connection refused' } });
    await service.snapshot();
    expect(ensure).not.toHaveBeenCalled();
  });
  it('cancels an explicit Enable if a newer Disable arrives during native setup', async () => {
    const { service, callTool, ensure } = fixture();
    let release!: () => void;
    ensure.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ endpoint: 'http://host.docker.internal:7716', token: 'a'.repeat(64) });
    }));
    const pending = service.action('enable');
    await service.action('disable');
    release();
    await expect(pending).rejects.toThrow('superseded');
    expect(callTool).not.toHaveBeenCalledWith('wm-embeddings-configure', expect.objectContaining({ action: 'enable' }));
  });
  it('repairs a changed WSL endpoint on refresh without enabling a disabled or paused environment', async () => {
    const { service, callTool, ensure, usesWslNetworking } = fixture();
    usesWslNetworking.mockReturnValue(true);
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, enabled: true, phase: 'error',
      endpoint: 'http://172.20.0.1:7716', error: 'Host inference service unavailable: connection refused' } });
    ensure.mockResolvedValue({ endpoint: 'http://172.24.32.1:7716', token: 'a'.repeat(64) });
    await service.snapshot();
    expect(callTool).toHaveBeenCalledWith('wm-embeddings-configure', {
      action: 'retry', host: { endpoint: 'http://172.24.32.1:7716', token: 'a'.repeat(64) },
      expectedConfiguration: dashboard.configurationKey,
    });
    callTool.mockClear(); ensure.mockClear();
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, enabled: true, paused: true, phase: 'paused' } });
    await service.snapshot();
    expect(ensure).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalledWith('wm-embeddings-configure', expect.anything());
  });
  it('does not undo Pause when endpoint discovery completes after a newer action', async () => {
    const { service, callTool, ensure, usesWslNetworking } = fixture();
    usesWslNetworking.mockReturnValue(true);
    callTool.mockResolvedValue({ ok: true, result: { ...dashboard, enabled: true, phase: 'error',
      error: 'Host inference service unavailable: connection refused' } });
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      ensure.mockImplementationOnce(() => new Promise(complete => {
        release = () => complete({ endpoint: 'http://172.24.32.1:7716', token: 'a'.repeat(64) });
        resolve();
      }));
    });
    const pending = service.snapshot();
    await started;
    await service.action('pause');
    release();
    await pending;
    expect(callTool).not.toHaveBeenCalledWith('wm-embeddings-configure', expect.objectContaining({ action: 'retry' }));
  });
  it('saves host-wide retention without enabling indexing', async () => {
    const { service, setRetention, callTool } = fixture();
    expect(await service.setRetention(30)).toMatchObject({ enabled: false, idleTimeoutMinutes: 30 });
    expect(setRetention).toHaveBeenCalledWith(30);
    expect(await service.snapshot()).toMatchObject({ idleTimeoutMinutes: 30 });
    expect(callTool).toHaveBeenCalledWith('wm-embeddings-dashboard', {});
    expect(callTool).not.toHaveBeenCalledWith('wm-embeddings-configure', expect.anything());
  });
  it('reads container diagnostics without starting a desktop indexing loop', async () => {
    const { service, callTool, ensure } = fixture();
    expect(await service.snapshot()).toMatchObject({ endpoint: 'http://127.0.0.1:7717/mcp', enabled: false });
    expect(ensure).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledExactlyOnceWith('wm-embeddings-dashboard', {});
  });
  it('installs the independent service and configures the selected container on enablement', async () => {
    const { service, ensure, callTool } = fixture();
    await service.action('enable');
    expect(ensure).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith('wm-embeddings-configure', {
      action: 'enable', host: { endpoint: 'http://host.docker.internal:7716', token: 'a'.repeat(64) },
    });
    await service.action('pause');
    await service.action('disable');
    expect(ensure).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenLastCalledWith('wm-embeddings-configure', { action: 'disable' });
  });
  it('does not configure another environment after a switch during installation', async () => {
    const { service, ensure, callTool, switchTo } = fixture();
    ensure.mockImplementationOnce(async () => {
      switchTo('http://127.0.0.1:7719/mcp');
      return { endpoint: 'http://host.docker.internal:7716', token: 'a'.repeat(64) };
    });
    await expect(service.action('enable')).rejects.toThrow('Selected environment changed');
    expect(callTool).not.toHaveBeenCalled();
  });
  it('surfaces installation errors and refuses to attach remote containers to the local host', async () => {
    const { service, ensure, callTool, switchTo } = fixture();
    ensure.mockRejectedValueOnce(new Error('Background task registration failed'));
    await expect(service.action('enable')).rejects.toThrow('registration failed');
    expect(callTool).not.toHaveBeenCalled();
    switchTo('https://example.test/mcp');
    await expect(service.action('retry')).rejects.toThrow('local container');
    expect(ensure).toHaveBeenCalledOnce();
  });
});
