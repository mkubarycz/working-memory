import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendToolResults, createModelConversation } from '../src/main/modelTools';

const sdk = vi.hoisted(() => {
  const session = {
    sessionId: 'isolated-session',
    sendAndWait: vi.fn(),
    abort: vi.fn(async () => {}),
  };
  const client = {
    start: vi.fn(async () => {}),
    getAuthStatus: vi.fn(),
    listModels: vi.fn(),
    createSession: vi.fn(async () => session),
    deleteSession: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
  };
  return { session, client, construct: vi.fn() };
});

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    constructor(options: unknown) {
      sdk.construct(options);
      return sdk.client;
    }
  },
  RuntimeConnection: { forStdio: (options: unknown) => options },
}));

import { copilotConnection, copilotEnvironment, localCopilotPath, LocalCopilotProvider, parseCopilotTurn, unpackedCopilotPath } from '../src/main/copilotProvider';

const tools = [{ name: 'ws-topic-read', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WM_COPILOT_CLI_PATH', process.execPath);
  sdk.client.getAuthStatus.mockResolvedValue({ isAuthenticated: true, login: 'test-user' });
  sdk.client.listModels.mockResolvedValue([
    { id: 'auto', name: 'Auto' },
    { id: 'allowed', name: 'Allowed', policy: { state: 'enabled' } },
    { id: 'blocked', name: 'Blocked', policy: { state: 'disabled' } },
  ]);
  sdk.session.sendAndWait.mockResolvedValue({ data: { content: 'connected' } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('local Copilot provider', () => {
  it('uses the local CLI, reuses sign-in and client, and discovers permitted models', async () => {
    const provider = new LocalCopilotProvider();
    expect(await provider.listModels()).toEqual({
      account: 'test-user', models: [{ id: 'auto', name: 'Auto' }, { id: 'allowed', name: 'Allowed' }],
    });
    expect(await provider.complete('auto', 'Reply connected', 1000)).toBe('connected');
    expect(sdk.construct).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ path: process.execPath }),
    }));
    expect(sdk.client.start).toHaveBeenCalledTimes(2);
    expect(sdk.construct).toHaveBeenCalledTimes(1);
    expect(sdk.client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'auto',
      availableTools: [],
      excludedTools: ['builtin:*', 'mcp:*', 'custom:*'],
      skipCustomInstructions: true,
      enableConfigDiscovery: false,
      systemMessage: expect.objectContaining({ mode: 'replace' }),
      infiniteSessions: { enabled: false },
    }));
    const options = sdk.client.createSession.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(sdk.client.deleteSession).toHaveBeenCalledWith('isolated-session');
    await provider.stop();
    expect(sdk.client.stop).toHaveBeenCalledTimes(1);
  });

  it('does not inherit BYOK endpoint overrides or Electron Node mode', () => {
    expect(copilotEnvironment({
      PATH: '/bin', GH_TOKEN: 'github-token', COPILOT_PROVIDER_BASE_URL: 'https://azure.example',
      COPILOT_PROVIDER_API_KEY: 'azure-key', COPILOT_MODEL: 'azure-model', COPILOT_OFFLINE: 'true',
      ELECTRON_RUN_AS_NODE: '1', EMPTY: undefined,
      COPILOT_CLI_PATH: '/external/copilot',
    })).toEqual({ PATH: '/bin', GH_TOKEN: 'github-token' });
  });

  it('reports a missing explicitly configured CLI instead of choosing another runtime', () => {
    expect(() => localCopilotPath({ WM_COPILOT_CLI_PATH: '/not-a-real-cli/copilot' })).toThrow('does not point to an executable');
  });

  it.each(['darwin', 'win32'] as const)('uses the bundled runtime even when external launchers exist on %s', (platform) => {
    const exists = vi.fn(() => true);
    expect(localCopilotPath({ PATH: '/usr/local/bin', Path: 'C:\\npm' }, platform, exists)).toBeUndefined();
    expect(exists).not.toHaveBeenCalled();
  });

  it('does not let inherited SDK overrides bypass the bundled runtime selection', () => {
    expect(copilotConnection({
      PATH: '/usr/bin:/bin', COPILOT_CLI_PATH: '/external/copilot', WM_COPILOT_CLI_PATH: 'bundled',
    })).toEqual({ env: { PATH: '/usr/bin:/bin', WM_COPILOT_CLI_PATH: 'bundled' } });
  });

  it('accepts an explicitly configured external executable on Windows', () => {
    const path = 'C:\\Copilot\\copilot.exe';
    expect(localCopilotPath({ WM_COPILOT_CLI_PATH: path }, 'win32', (candidate) => candidate === path)).toBe(path);
  });

  it('launches the unpacked Windows runtime rather than a path inside app.asar', () => {
    expect(unpackedCopilotPath(
      'C:\\Program Files\\Working Memory\\resources\\app.asar\\node_modules\\@github\\copilot-sdk-win32-x64\\package.json',
      'win32', 'x64',
    )).toBe('C:\\Program Files\\Working Memory\\resources\\app.asar.unpacked\\node_modules\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe');
  });

  it('launches the unpacked macOS runtime and leaves unarchived installations to the SDK', () => {
    expect(unpackedCopilotPath(
      '/Applications/Working Memory.app/Contents/Resources/app.asar/node_modules/@github/copilot-sdk-darwin-arm64/package.json',
      'darwin', 'arm64',
    )).toBe('/Applications/Working Memory.app/Contents/Resources/app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime');
    expect(unpackedCopilotPath(
      '/app/node_modules/@github/copilot-sdk-darwin-arm64/package.json', 'darwin', 'arm64',
    )).toBeUndefined();
    expect(unpackedCopilotPath(
      '/app/app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-arm64/package.json', 'darwin', 'arm64',
    )).toBeUndefined();
  });

  it('reports a missing unpacked runtime before attempting to start it', () => {
    expect(() => copilotConnection({ WM_COPILOT_CLI_PATH: 'bundled' },
      () => '/missing/app.asar/node_modules/@github/copilot-sdk/package.json',
    )).toThrow('Reinstall Working Memory');
  });

  it('creates a fresh client after startup fails and allows a later request', async () => {
    sdk.client.start.mockRejectedValueOnce(new Error('CLI process exited during startup'));
    const provider = new LocalCopilotProvider();
    await expect(provider.complete('auto', 'hello', 1000)).rejects.toThrow('CLI process exited during startup');
    expect(await provider.complete('auto', 'hello again', 1000)).toBe('connected');
    expect(sdk.construct).toHaveBeenCalledTimes(2);
  });

  it('checks the runtime again after a previously successful connection', async () => {
    const provider = new LocalCopilotProvider();
    await provider.listModels();
    sdk.client.start.mockRejectedValueOnce(new Error('Runtime has disconnected'));
    await expect(provider.complete('auto', 'hello', 1000)).rejects.toThrow('Runtime has disconnected');
    expect(sdk.client.start).toHaveBeenCalledTimes(2);
  });

  it('reports missing authentication without creating a session', async () => {
    sdk.client.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    await expect(new LocalCopilotProvider().complete('auto', 'hello', 1000)).rejects.toThrow('copilot login');
    expect(sdk.client.createSession).not.toHaveBeenCalled();
  });

  it('reports policy/model errors and deletes failed sessions without falling back', async () => {
    sdk.session.sendAndWait.mockRejectedValueOnce(new Error('Model disabled by organization policy'));
    await expect(new LocalCopilotProvider().complete('blocked', 'hello', 1000)).rejects.toThrow('organization policy');
    expect(sdk.client.deleteSession).toHaveBeenCalledWith('isolated-session');
    expect(sdk.client.createSession).toHaveBeenCalledTimes(1);
  });

  it('preserves the original request error when deleting a dead session also fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    sdk.session.sendAndWait.mockRejectedValueOnce(new Error('Runtime exited: startup diagnostic'));
    sdk.client.deleteSession.mockRejectedValueOnce(new Error('Cannot call write after a stream was destroyed'));
    try {
      await expect(new LocalCopilotProvider().complete('auto', 'hello', 1000))
        .rejects.toThrow('Runtime exited: startup diagnostic');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete session'), expect.any(Error),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('reports session cleanup failures after an otherwise successful request', async () => {
    sdk.client.deleteSession.mockRejectedValueOnce(new Error('Session cleanup failed'));
    await expect(new LocalCopilotProvider().complete('auto', 'hello', 1000))
      .rejects.toThrow('Session cleanup failed');
  });

  it('rejects empty responses', async () => {
    sdk.session.sendAndWait.mockResolvedValueOnce({ data: { content: ' ' } });
    await expect(new LocalCopilotProvider().complete('auto', 'hello', 1000)).rejects.toThrow('no response');
    expect(sdk.client.deleteSession).toHaveBeenCalledWith('isolated-session');
  });

  it('bounds requests, aborts the runtime, and cleans up the session', async () => {
    vi.useFakeTimers();
    sdk.session.sendAndWait.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      sdk.session.abort.mockImplementationOnce(async () => { reject(new Error('aborted')); });
    }));
    const request = new LocalCopilotProvider().complete('auto', 'hello', 100);
    const rejected = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(sdk.session.abort).toHaveBeenCalled();
    expect(sdk.client.deleteSession).toHaveBeenCalledWith('isolated-session');
  });

  it('does not start an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new LocalCopilotProvider().complete('auto', 'hello', 1000, controller.signal)).rejects.toThrow('cancelled');
    expect(sdk.client.start).not.toHaveBeenCalled();
  });

  it('keeps each model turn isolated and supplies previous tool results without executing Copilot tools', async () => {
    sdk.session.sendAndWait
      .mockResolvedValueOnce({ data: { content: '{"text":"","calls":[{"name":"ws-topic-read","arguments":{"id":"test"}}]}' } })
      .mockResolvedValueOnce({ data: { content: '{"text":"Read the topic.","calls":[]}' } });
    const provider = new LocalCopilotProvider();
    const conversation = createModelConversation({
      mode: 'chat-completions', model: 'auto', systemPrompt: 'Working Memory rules',
      userMessage: 'Read test', tools,
    });
    const turn = await provider.turn(conversation, 1000, new AbortController().signal);
    expect(turn.calls[0]).toMatchObject({ name: 'ws-topic-read', arguments: { id: 'test' } });
    appendToolResults(conversation, turn, [{ call: turn.calls[0], output: { title: 'Test' } }]);
    expect(await provider.turn(conversation, 1000, new AbortController().signal)).toMatchObject({
      text: 'Read the topic.', calls: [],
    });
    expect(sdk.session.sendAndWait.mock.calls[1][0].prompt).toContain('\\"title\\":\\"Test\\"');
    expect(sdk.client.createSession).toHaveBeenCalledTimes(2);
    expect(sdk.client.deleteSession).toHaveBeenCalledTimes(2);
  });

  it('passes images as SDK attachments rather than embedding base64 in the transcript', async () => {
    sdk.session.sendAndWait.mockResolvedValueOnce({ data: { content: '{"text":"An image.","calls":[]}' } });
    const provider = new LocalCopilotProvider();
    await provider.turn(createModelConversation({
      mode: 'chat-completions', model: 'auto', systemPrompt: 'Describe images', userMessage: 'Describe',
      tools: [], userImages: [{ id: 'image-1', filename: 'test.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    }), 1000, new AbortController().signal);
    expect(sdk.session.sendAndWait).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{ type: 'blob', mimeType: 'image/png', data: 'aGVsbG8=', displayName: 'Image 1' }],
    }), 1000);
    expect(sdk.session.sendAndWait.mock.calls[0][0].prompt).not.toContain('aGVsbG8=');
  });
});

describe('Copilot model-turn validation', () => {
  it('accepts final responses and fenced JSON without losing assistant/tool transcript shape', () => {
    expect(parseCopilotTurn('```json\n{"text":"Done","calls":[]}\n```', tools)).toMatchObject({ text: 'Done', calls: [] });
  });

  it.each([
    'not JSON',
    '{"text":"Done"}',
    '{"text":"","calls":[]}',
    '{"text":"","calls":[{"name":"shell","arguments":{}}]}',
    '{"text":"","calls":[{"name":"ws-topic-read","arguments":"invalid"}]}',
    '{"text":"","calls":[{"name":"ws-topic-read","arguments":[]}]}',
  ])('rejects malformed or unauthorized proposals: %s', (text) => {
    expect(() => parseCopilotTurn(text, tools)).toThrow();
  });
});
