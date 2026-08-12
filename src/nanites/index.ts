/**
 * Public surface of the isolated nanite run engine. Everything outside
 * `src/nanites/` should import ONLY from this barrel — the tool-calling loop,
 * the `vscode.lm` bridge, and the acceptance judge never leak past it.
 */

export type {
  NaniteAcceptance,
  NaniteContainer,
  NaniteContainerExecResult,
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
  DevContainer,
  defaultProcessRunner,
  registerContainerTools,
  isContainerTool,
  invokeContainerTool,
  type ContainerToolDefinition,
  type DevContainerConfig,
  type ProcessRunner,
  type ProcessRunResult,
  RUN_COMMAND_TOOL,
  isRunCommandTool,
  parseRunCommandInput,
  formatRunCommandResult,
  invokeContainerCommand,
  EXPOSE_PORT_TOOL,
  isExposePortTool,
  parseExposePortInput,
  invokeExposePort,
} from '../tools/NaniteDevContainer';
export {
  EXTENSION_HOST_RUNNER_ID,
  ExtensionHostNaniteRunner,
  type ExtensionHostRunnerDeps,
  type NaniteRunnerClient,
} from './extensionHostRunner';
export { NaniteRunnerRegistry, providerFromSettings } from './registry';
export {
  NaniteDispatcher,
  selectDispatchable,
  type DispatcherClient,
  type NaniteDispatcherDeps,
} from './dispatcher';
