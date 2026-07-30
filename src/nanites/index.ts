/**
 * Public surface of the isolated nanite run engine. Everything outside
 * `src/nanites/` should import ONLY from this barrel — the tool-calling loop,
 * the `vscode.lm` bridge, and the acceptance judge never leak past it.
 */

export type {
  NaniteAcceptance,
  NaniteLmBridge,
  NaniteRunResult,
  NaniteRunner,
  RunNaniteOptions,
  RunnerToken,
  ToolCallOutcome,
} from './types';
export { runNanite } from './runner';
export { VscodeLmBridge } from './vscodeBridge';
export {
  EXTENSION_HOST_RUNNER_ID,
  ExtensionHostNaniteRunner,
  type ExtensionHostRunnerDeps,
  type NaniteRunnerClient,
} from './extensionHostRunner';
export { NaniteRunnerRegistry, providerFromSettings } from './registry';
