import { describe, expect, it, vi } from 'vitest';
import { LocalEmbeddings } from '../src/main/localEmbeddings';
import { EMBEDDING_MODEL, EMBEDDING_DOWNLOAD_BYTES } from '../../control-plane/src/embeddingContract';

const dashboard = { endpoint: null, enabled: false, paused: false, phase: 'disabled', model: EMBEDDING_MODEL,
  downloadBytes: 0, downloadTotal: EMBEDDING_DOWNLOAD_BYTES, backend: null, warning: null, error: null,
  rssBytes: null, lastInferenceMs: null, lastSuccessAtMs: null, stats: null };
function fixture() {
  let endpoint = 'http://127.0.0.1:7717/mcp';
  const callTool = vi.fn(async () => ({ ok: true as const, result: dashboard }));
  const ensure = vi.fn(async () => ({ endpoint: 'http://host.docker.internal:7716', token: 'a'.repeat(64) }));
  let minutes: number | null = null;
  const readSettings = () => ({ idleTimeoutMinutes: minutes });
  const setRetention = vi.fn(async (value: number | null) => { minutes = value; return readSettings(); });
  const usesWslNetworking = vi.fn(() => false);
  const service = new LocalEmbeddings(() => ({ endpoint, client: { callTool } }), { ensure, readSettings, setRetention, usesWslNetworking });
  return { service, callTool, ensure, setRetention, usesWslNetworking, switchTo: (value: string) => { endpoint = value; } };
}
describe('desktop background indexing controls', () => {
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
