import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deployTemplates,
  deployTemplatesCore,
} from '../src/deployTemplates';

let tmpRoot: string;
let extensionPath: string;
let hub: string;

const AGENT_REL = '.github/agents/working-memory.agent.md';
const AGENTS_REL = 'AGENTS.md';
const USER_REL = '.github/prompts/user.instructions.md';

function writeSource(name: string, content: string): void {
  const dir = path.join(extensionPath, 'media', 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function fakeContext(): { extensionUri: { fsPath: string } } {
  return { extensionUri: { fsPath: extensionPath } };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-deploy-test-'));
  extensionPath = path.join(tmpRoot, 'ext');
  hub = path.join(tmpRoot, 'hub');
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  writeSource('working-memory.agent.md', 'AGENT_V1');
  writeSource('AGENTS.md', 'AGENTS_V1');
  writeSource('user.instructions.md', 'USER_V1');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('deployTemplates', () => {
  test('fresh hub: all three files written, no backup, agent freshly created', () => {
    const outcome = deployTemplatesCore(extensionPath, hub);

    expect(outcome.errors).toEqual([]);
    expect(outcome.agentFreshlyCreated).toBe(true);
    expect(fs.readFileSync(path.join(hub, AGENT_REL), 'utf8')).toBe('AGENT_V1');
    expect(fs.readFileSync(path.join(hub, AGENTS_REL), 'utf8')).toBe('AGENTS_V1');
    expect(fs.readFileSync(path.join(hub, USER_REL), 'utf8')).toBe('USER_V1');

    // No rotated backup files exist.
    const agentsDir = path.join(hub, '.github/agents');
    const listing = fs.readdirSync(agentsDir);
    expect(listing.some((f) => f.endsWith('.backup'))).toBe(false);
  });

  test('existing working-memory.agent.md rotates to .0.backup and fresh copy is written', () => {
    fs.mkdirSync(path.join(hub, '.github/agents'), { recursive: true });
    fs.writeFileSync(path.join(hub, AGENT_REL), 'AGENT_OLD');

    writeSource('working-memory.agent.md', 'AGENT_V2');
    const outcome = deployTemplatesCore(extensionPath, hub);

    expect(outcome.errors).toEqual([]);
    expect(outcome.agentFreshlyCreated).toBe(false);
    expect(fs.readFileSync(path.join(hub, AGENT_REL), 'utf8')).toBe('AGENT_V2');
    expect(
      fs.readFileSync(
        path.join(hub, '.github/agents/working-memory.agent.md.0.backup'),
        'utf8',
      ),
    ).toBe('AGENT_OLD');
  });

  test('multiple rotations produce .0, .1, .2 backups in sequence', () => {
    // Round 1: no prior file → fresh write.
    writeSource('working-memory.agent.md', 'V1');
    deployTemplatesCore(extensionPath, hub);

    // Round 2: V1 rotates to .0.backup, V2 written.
    writeSource('working-memory.agent.md', 'V2');
    deployTemplatesCore(extensionPath, hub);

    // Round 3: V2 rotates to .1.backup, V3 written.
    writeSource('working-memory.agent.md', 'V3');
    deployTemplatesCore(extensionPath, hub);

    // Round 4: V3 rotates to .2.backup, V4 written.
    writeSource('working-memory.agent.md', 'V4');
    deployTemplatesCore(extensionPath, hub);

    const agentsDir = path.join(hub, '.github/agents');
    expect(fs.readFileSync(path.join(agentsDir, 'working-memory.agent.md'), 'utf8')).toBe('V4');
    expect(fs.readFileSync(path.join(agentsDir, 'working-memory.agent.md.0.backup'), 'utf8')).toBe('V1');
    expect(fs.readFileSync(path.join(agentsDir, 'working-memory.agent.md.1.backup'), 'utf8')).toBe('V2');
    expect(fs.readFileSync(path.join(agentsDir, 'working-memory.agent.md.2.backup'), 'utf8')).toBe('V3');
  });

  test('existing AGENTS.md and user.instructions.md are NOT overwritten', () => {
    fs.writeFileSync(path.join(hub, AGENTS_REL), 'KEEP_AGENTS');
    fs.mkdirSync(path.join(hub, '.github/prompts'), { recursive: true });
    fs.writeFileSync(path.join(hub, USER_REL), 'KEEP_USER');

    const outcome = deployTemplatesCore(extensionPath, hub);

    expect(outcome.errors).toEqual([]);
    expect(fs.readFileSync(path.join(hub, AGENTS_REL), 'utf8')).toBe('KEEP_AGENTS');
    expect(fs.readFileSync(path.join(hub, USER_REL), 'utf8')).toBe('KEEP_USER');
    // Agent template still deploys.
    expect(fs.readFileSync(path.join(hub, AGENT_REL), 'utf8')).toBe('AGENT_V1');
  });

  test('missing source template: error logged, other files still deploy', () => {
    fs.unlinkSync(path.join(extensionPath, 'media/prompts/AGENTS.md'));

    const outcome = deployTemplatesCore(extensionPath, hub);

    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.source).toBe('AGENTS.md');
    expect(fs.existsSync(path.join(hub, AGENTS_REL))).toBe(false);
    expect(fs.readFileSync(path.join(hub, AGENT_REL), 'utf8')).toBe('AGENT_V1');
    expect(fs.readFileSync(path.join(hub, USER_REL), 'utf8')).toBe('USER_V1');
  });

  test('public deployTemplates accepts a minimal context shape', () => {
    expect(() =>
      deployTemplates(fakeContext() as never, hub),
    ).not.toThrow();
    expect(fs.existsSync(path.join(hub, AGENT_REL))).toBe(true);
  });
});
