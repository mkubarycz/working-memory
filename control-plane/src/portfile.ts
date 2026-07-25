/**
 * Discovery port file for the control-plane daemon.
 *
 * The daemon writes `{ port, pid }` as JSON once its server is bound, so every
 * client (the extension, the Blackboard app, Nanites) can discover the single
 * running instance's endpoint. Written atomically (temp + rename) so a reader
 * never observes a half-written file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PortInfo {
  port: number;
  pid: number;
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/** Atomically write the port file (`{ port, pid }`) as JSON. */
export function writePortFile(portFilePath: string, info: PortInfo): void {
  if (!isValidPort(info.port)) {
    throw new Error(`invalid port: ${String(info.port)}`);
  }
  if (!isValidPid(info.pid)) {
    throw new Error(`invalid pid: ${String(info.pid)}`);
  }

  fs.mkdirSync(path.dirname(portFilePath), { recursive: true });
  const payload = JSON.stringify({ port: info.port, pid: info.pid });
  const tmp = `${portFilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, portFilePath); // atomic replace on the same filesystem
}

/** Read + validate the port file. Returns null when missing or malformed. */
export function readPortFile(portFilePath: string): PortInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(portFilePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { port, pid } = parsed as Record<string, unknown>;
  if (!isValidPort(port) || !isValidPid(pid)) {
    return null;
  }
  return { port, pid };
}

/** Remove the port file (best-effort; idempotent). */
export function removePortFile(portFilePath: string): void {
  fs.rmSync(portFilePath, { force: true });
}
