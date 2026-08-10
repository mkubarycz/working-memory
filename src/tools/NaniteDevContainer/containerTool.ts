/**
 * The `run_command` nanite tool — a VS Code-free definition + routing helper so
 * the bridge (which imports `vscode`) stays thin and the tool's schema, input
 * parsing, and result formatting are directly unit-testable.
 *
 * `run_command` is registered PER-RUN (only when a run has a dev container
 * attached), NOT as a global `vscode.lm` tool: it is offered alongside the
 * resolved MCP tools and routed to {@link NaniteContainer.exec}.
 */

import type { NaniteContainer, NaniteContainerExecResult, RunnerToken } from '../../nanites/types';

/** The clean tool name offered to (and enforced against) the model. */
export const RUN_COMMAND_TOOL = 'run_command';

export const RUN_COMMAND_TOOL_DESCRIPTION =
  'Run a shell command inside this run\'s isolated dev container (bash -lc). ' +
  'Use it to clone, branch, build, test, and edit files (via sed/heredoc/' +
  'apply_patch). Returns the command\'s stdout, stderr, and exit code.';

/** JSON schema for the tool input — `{ command, cwd? }`. */
export const RUN_COMMAND_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The shell command to run inside the container (via bash -lc).',
    },
    cwd: {
      type: 'string',
      description:
        'Optional working directory inside the container to run the command from.',
    },
  },
  required: ['command'],
};

/** Whether a tool call name targets the per-run `run_command` tool. */
export function isRunCommandTool(name: string): boolean {
  return name === RUN_COMMAND_TOOL;
}

/** Parse + validate the model-supplied `run_command` input. */
export function parseRunCommandInput(input: unknown): { command: string; cwd?: string } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (!command) {
    throw new Error('run_command requires a non-empty "command" string');
  }
  const cwd =
    typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : undefined;
  return cwd ? { command, cwd } : { command };
}

/** Cap on each stream fed back to the model, keeping the (more useful) tail. */
const MAX_STREAM = 6000;

function tail(text: string, max = MAX_STREAM): string {
  if (text.length <= max) {
    return text;
  }
  return `…(truncated)…\n${text.slice(-max)}`;
}

/** Format an exec result into the JSON string handed back to the model. */
export function formatRunCommandResult(res: NaniteContainerExecResult): string {
  return JSON.stringify({
    exitCode: res.exitCode,
    stdout: tail(res.stdout),
    stderr: tail(res.stderr),
  });
}

/** Route a `run_command` tool call to the run's container and format the result. */
export async function invokeContainerCommand(
  container: NaniteContainer,
  input: unknown,
  token?: RunnerToken,
): Promise<string> {
  const { command, cwd } = parseRunCommandInput(input);
  const res = await container.exec(command, { cwd, token });
  return formatRunCommandResult(res);
}

// ---------------------------------------------------------------------------
// expose_port: turn a container port into a host-reachable URL at runtime.
// ---------------------------------------------------------------------------

/** The clean tool name offered to (and enforced against) the model. */
export const EXPOSE_PORT_TOOL = 'expose_port';

export const EXPOSE_PORT_TOOL_DESCRIPTION =
  'Get the host-reachable URL for the app running in this run\'s dev container. ' +
  'Call this after you start a server inside the container; it returns the ' +
  'clickable link (https://<name>.orb.local/) to open the app from the host. ' +
  'The "port" is optional and informational only — the URL has no :port suffix.';

/** JSON schema for the tool input — `{ port? }`. */
export const EXPOSE_PORT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    port: {
      type: 'number',
      description:
        'Optional: the TCP port your server listens on inside the container ' +
        '(informational only — not appended to the returned URL).',
    },
  },
};

/** Whether a tool call name targets the per-run `expose_port` tool. */
export function isExposePortTool(name: string): boolean {
  return name === EXPOSE_PORT_TOOL;
}

/** Parse + validate the model-supplied `expose_port` input. */
export function parseExposePortInput(input: unknown): { port?: number } {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (obj.port === undefined || obj.port === null || obj.port === '') {
    return {};
  }
  const port = typeof obj.port === 'number' ? obj.port : Number(obj.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('expose_port "port" must be an integer between 1 and 65535');
  }
  return { port };
}

/** Route an `expose_port` tool call to the run's container; returns the URL text. */
export async function invokeExposePort(
  container: NaniteContainer,
  input: unknown,
  token?: RunnerToken,
): Promise<string> {
  const { port } = parseExposePortInput(input);
  if (!container.exposePort) {
    throw new Error('expose_port is not supported by this run\'s container');
  }
  const { url } = await container.exposePort(port, { token });
  return url;
}
