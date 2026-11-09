import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerHeadlessDesktopActivation } from '../src/main/headlessDesktopActivation';

describe('headless desktop activation', () => {
  it('only launches a desktop when the background process receives an activation', async () => {
    const application = new EventEmitter();
    const launch = vi.fn(async () => {});
    const reportError = vi.fn();
    registerHeadlessDesktopActivation(application, launch, reportError);
    expect(launch).not.toHaveBeenCalled();
    application.emit('activate');
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch).toHaveBeenCalledWith();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('forwards valid resource links without consuming unrelated URLs', async () => {
    const application = new EventEmitter();
    const launch = vi.fn(async (_url?: string) => {});
    const reportError = vi.fn();
    registerHeadlessDesktopActivation(application, launch, reportError);
    const event = { preventDefault: vi.fn() };
    application.emit('open-url', event, 'https://example.invalid');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    const url = 'working-memory://open/topic/launch-test';
    application.emit('open-url', event, url);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledWith(url));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each(['activate', 'open-url'])('surfaces a failed %s launch', async event => {
    const application = new EventEmitter();
    const failure = new Error('Launch Services failed');
    const launch = vi.fn(async () => { throw failure; });
    const reportError = vi.fn();
    registerHeadlessDesktopActivation(application, launch, reportError);
    application.emit(event, { preventDefault() {} }, 'working-memory://open/topic/launch-test');
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure));
  });
});
