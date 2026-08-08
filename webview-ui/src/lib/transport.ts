import type { ExtToWebview, WebviewToExt } from './types';

/**
 * Transport seam between the Svelte UI and its host (WM 14.2).
 *
 * The UI never imports VS Code APIs. It speaks to whatever hosts it through
 * this narrow interface. Today the only implementation is the postMessage
 * transport backed by the VS Code webview API; a future standalone (Electron)
 * shell would provide a direct-control-plane `Transport` here instead, without
 * the UI changing.
 */
export interface Transport {
  post(msg: WebviewToExt): void;
  /** Subscribe to host→UI messages. Returns an unsubscribe function. */
  subscribe(handler: (msg: ExtToWebview) => void): () => void;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** postMessage transport backed by the VS Code webview API. */
export function createVsCodeTransport(): Transport {
  const vscode = acquireVsCodeApi();
  return {
    post(msg) {
      vscode.postMessage(msg);
    },
    subscribe(handler) {
      const listener = (event: MessageEvent): void =>
        handler(event.data as ExtToWebview);
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
}
