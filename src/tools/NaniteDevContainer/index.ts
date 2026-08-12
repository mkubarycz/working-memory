/**
 * Public surface of the NaniteDevContainer tool module — a self-contained,
 * `vscode`-free unit that gives a headless nanite run an isolated dev container
 * to work in (`run_command`) and a way to expose a container port to the host
 * at runtime (`expose_port`).
 *
 * Everything here shells out via the injected {@link ProcessRunner} (Node
 * `child_process`) and never imports `vscode` — the only editor coupling lives
 * in the bridge adapter (`src/nanites/vscodeBridge.ts`), which consumes this
 * barrel. Keeping the cores editor-free keeps the whole module unit-testable
 * without Docker (see `tests/naniteDevContainer.test.ts`).
 */

import type { NaniteContainer, RunnerToken } from '../../nanites/types';
import {
  RUN_COMMAND_TOOL,
  RUN_COMMAND_TOOL_DESCRIPTION,
  RUN_COMMAND_INPUT_SCHEMA,
  isRunCommandTool,
  invokeContainerCommand,
  EXPOSE_PORT_TOOL,
  EXPOSE_PORT_TOOL_DESCRIPTION,
  EXPOSE_PORT_INPUT_SCHEMA,
  isExposePortTool,
  invokeExposePort,
} from './containerTool';

export {
  DevContainer,
  defaultProcessRunner,
  ID_LABEL_KEY,
  type DevContainerConfig,
  type ProcessRunner,
  type ProcessRunResult,
  type ProcessRunOptions,
} from './devcontainer';
export {
  RUN_COMMAND_TOOL,
  RUN_COMMAND_TOOL_DESCRIPTION,
  RUN_COMMAND_INPUT_SCHEMA,
  isRunCommandTool,
  parseRunCommandInput,
  formatRunCommandResult,
  invokeContainerCommand,
  EXPOSE_PORT_TOOL,
  EXPOSE_PORT_TOOL_DESCRIPTION,
  EXPOSE_PORT_INPUT_SCHEMA,
  isExposePortTool,
  parseExposePortInput,
  invokeExposePort,
} from './containerTool';

/** A per-run tool the bridge offers alongside the resolved MCP tools. */
export interface ContainerToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The per-run tool set this module offers for a given container. `run_command`
 * is always offered; `expose_port` is added only when the container supports
 * runtime port exposure (i.e. implements {@link NaniteContainer.exposePort}).
 */
export function registerContainerTools(
  container: NaniteContainer,
): ContainerToolDefinition[] {
  const tools: ContainerToolDefinition[] = [
    {
      name: RUN_COMMAND_TOOL,
      description: RUN_COMMAND_TOOL_DESCRIPTION,
      inputSchema: RUN_COMMAND_INPUT_SCHEMA,
    },
  ];
  if (container.exposePort) {
    tools.push({
      name: EXPOSE_PORT_TOOL,
      description: EXPOSE_PORT_TOOL_DESCRIPTION,
      inputSchema: EXPOSE_PORT_INPUT_SCHEMA,
    });
  }
  return tools;
}

/** Whether a tool call name targets one of this module's per-run tools. */
export function isContainerTool(name: string): boolean {
  return isRunCommandTool(name) || isExposePortTool(name);
}

/** Route a per-run container tool call to the container; returns its text result. */
export function invokeContainerTool(
  container: NaniteContainer,
  name: string,
  input: unknown,
  token?: RunnerToken,
): Promise<string> {
  if (isExposePortTool(name)) {
    return invokeExposePort(container, input, token);
  }
  return invokeContainerCommand(container, input, token);
}
