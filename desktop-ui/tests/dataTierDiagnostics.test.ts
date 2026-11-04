import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DataTierManager } from '../src/main/dataTier';
import { ExecFileCommandRunner, type CommandRunner } from '../src/main/dockerContainerService';

it.skipIf(!process.env.WM_DIAGNOSTICS_TEST_CONTAINER)(
  'returns only sanitized diagnostic evidence from a real isolated Docker container',
  async () => {
    const container = process.env.WM_DIAGNOSTICS_TEST_CONTAINER!;
    if (!/^wm141-monitor-validation-[a-z0-9]+$/.test(container)) throw new Error('Only isolated monitoring validation containers may be inspected.');
    const directory = mkdtempSync(join(tmpdir(), 'wm-docker-diagnostics-test-'));
    try {
      writeFileSync(join(directory, 'instances.json'), JSON.stringify({
        instances: [{ port: 7717, name: 'Validation', createdAt: new Date().toISOString() }],
      }));
      const exec = new ExecFileCommandRunner();
      const runner: CommandRunner = {
        run(file, args, options) {
          if (!options) throw new Error('Bounded Docker timeout required.');
          if (args[2] === 'context' || args[2] === 'info') return exec.run(file, args, options);
          expect(args.slice(2, 4)).toEqual(['container', 'inspect']);
          return exec.run(file, [...args.slice(0, -1), container], options);
        },
      };
      const manager = new DataTierManager({ buildContext: directory, stateDirectory: directory, version: '1.4.1', runner });
      const state = await manager.diagnosticState(7717);
      expect(state.startedAt).toMatch(/^\d{4}-/);
      expect(state.evidence).toContain('working-memory-control-plane:1.4.1');
      expect(state.evidence).toContain('OOM killed: false');
      expect(state.evidence).not.toContain('wm141-validation-bootstrap');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
);
