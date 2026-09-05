import type { DesktopApi } from '../shared/contracts';

declare global {
  interface Window {
    workingMemory: DesktopApi;
  }
}

export {};