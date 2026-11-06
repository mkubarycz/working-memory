import { expect, it } from 'vitest';
import { summarizeContainerLogs, summarizeContainerStats } from '../src/main/containerIncidentEvidence';

it('retains timestamped error categories, SQLite failures and safe stack locations without payloads', () => {
  const evidence = summarizeContainerLogs([
    '2026-11-05T21:47:01.000Z [control-plane] Request failed: TypeError: private document body',
    '2026-11-05T21:47:01.001Z     at handler (/app/out/control-plane/server.js:100:20)',
    '2026-11-05T21:47:01.002Z     at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '2026-11-05T21:47:01.003Z Error: database is locked',
    "2026-11-05T21:47:01.004Z   code: 'SQLITE_BUSY',",
    '2026-11-05T21:47:01.005Z FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    '2026-11-05T21:47:01.006Z Authorization: Bearer private-token',
    '2026-11-05T21:47:01.007Z {"body":"private document body","password":"private-password"}',
    '2026-11-05T21:47:01.008Z     at C:\\Users\\private-user\\private-file.js:10:2',
  ].join('\n'));
  expect(evidence).toContain('2026-11-05T21:47:01.000Z [control-plane] TypeError');
  expect(evidence).toContain('/app/out/control-plane/server.js:100:20');
  expect(evidence).toContain('node:internal/process/task_queues:95:5');
  expect(evidence).toContain('database is locked');
  expect(evidence).toContain('SQLITE_BUSY');
  expect(evidence).toContain('V8 fatal error: JavaScript heap out of memory');
  for (const secret of ['private document body', 'private-token', 'private-password', 'private-user']) {
    expect(evidence).not.toContain(secret);
  }
});

it('explicitly distinguishes absent recognized evidence from proof of no errors and bounds log excerpts', () => {
  expect(summarizeContainerLogs('arbitrary private text')).toContain('does not prove there were no errors');
  expect(summarizeContainerLogs('')).toContain('last 0 returned lines');
  const large = summarizeContainerLogs(Array.from({ length: 200 }, () =>
    '2026-11-05T21:47:01.000Z Error: private text').join('\n'));
  expect(large).toContain('Earlier log evidence truncated');
  expect(large.length).toBeLessThan(4300);
  expect(large).not.toContain('private text');
});

it.each([
  { CPUPerc: '99.12%', MemUsage: '785MiB / 3.826GiB', MemPerc: '20.1%', PIDs: '12', BlockIO: '400kB / 1MB' },
  [{ CPU: '99.12%', MemUsage: '785MiB / 3.826GiB', MemPerc: '20.1%', PIDS: 12, BlockIO: '400kB / 1MB' }],
])('keeps only numeric resource metrics from Docker and Podman JSON', value => {
  const evidence = summarizeContainerStats(JSON.stringify(value));
  expect(evidence).toContain('CPU 99.12%');
  expect(evidence).toContain('memory 785MiB / 3.826GiB');
  expect(evidence).toContain('PIDs 12');
  expect(evidence).toContain('block I/O 400kB / 1MB');
});

it('does not include unrelated container fields or invalid metric values', () => {
  const evidence = summarizeContainerStats(JSON.stringify({ Name: 'private-container', CPUPerc: '1%' }));
  expect(evidence).not.toContain('private-container');
  expect(evidence).toContain('memory unavailable');
  expect(() => summarizeContainerStats('not JSON')).toThrow();
  expect(() => summarizeContainerStats(JSON.stringify({ CPUPerc: 'private-value' }))).toThrow('Invalid container resource metric');
});
