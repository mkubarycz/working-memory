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
  const service = new LocalEmbeddings(() => ({ endpoint, client: { callTool } }), { ensure, readSettings, setRetention });
  return { service, callTool, ensure, setRetention, switchTo: (value: string) => { endpoint = value; } };
}
describe('desktop background indexing controls', () => {
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
    await expect(service.action('retry')).rejects.toThrow('local Docker');
    expect(ensure).toHaveBeenCalledOnce();
  });
});
