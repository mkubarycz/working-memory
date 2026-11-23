import { createHash } from 'node:crypto';

const themes = [
  ['database', 'migration', 'transaction', 'checkpoint', 'replication'],
  ['authentication', 'credential', 'permission', 'session', 'revocation'],
  ['rendering', 'markdown', 'decoration', 'selection', 'navigation'],
  ['deployment', 'container', 'installer', 'release', 'rollback'],
  ['monitoring', 'latency', 'throughput', 'memory', 'diagnostic'],
  ['indexing', 'passage', 'vocabulary', 'embedding', 'ranking'],
  ['network', 'transport', 'reconnection', 'timeout', 'endpoint'],
  ['workflow', 'workstream', 'placement', 'parent', 'backlog'],
];
const actions = ['Investigate', 'Repair', 'Measure', 'Document', 'Validate', 'Simplify', 'Restore', 'Compare'];

function random(seed, index) {
  return createHash('sha256').update(`${seed}:${index}`).digest().readUInt32LE(0);
}

export function realisticTopic(seed, index) {
  const value = random(seed, index);
  const family = value % 128;
  const theme = themes[family % themes.length];
  const bucket = (value >>> 8) % 100;
  const bodyUnits = bucket < 50 ? 512 : bucket < 85 ? 2048 : bucket < 99 ? 8192 : 36000;
  const title = `${actions[family % actions.length]} ${theme[0]} evidence ${family}`;
  const reference = `TRACE-${seed}/${String(index).padStart(6, '0')}`;
  const prefix = `# ${title}\n\nReference: ${reference}\n\n## Observed behaviour\n`;
  const sections = [
    `The ${theme[0]} workflow needs reproducible evidence before changing ${theme[1]} policy. ` +
      `Compare ${theme[2]} results with ${theme[3]} history and preserve ${theme[4]} semantics.\n\n`,
    `- Component: service_${family}.handler\n- Endpoint: /api/v${family % 4 + 1}/${theme[0]}\n` +
      `- Expected: preserve authored content and report failures explicitly.\n\n`,
    `\`\`\`text\nrequest_id=group-${family}; resource_version=17\n` +
      `status=pending; retry_after=250ms\n\`\`\`\n\n`,
    `## Evidence and recovery\n\nMeasure first-request and warm latency separately. ` +
      `Keep database ownership in the control plane. Verify eligibility, exact references, ` +
      `and the phrase "current index" before suggesting a relationship.\n\n`,
    `| Check | Observation |\n| --- | --- |\n| ${theme[1]} | Compare same input |\n` +
      `| ${theme[2]} | Do not silently discard errors |\n\n`,
  ];
  // Unicode paths exercise the general matcher without making every document non-ASCII.
  if (family % 16 === 0) sections.push('Identifiers: cafe\u0301/ref-42, Δοκιμή-17, 東京/履歴.\n\n');
  let body = prefix;
  for (let i = 0; body.length < bodyUnits; i++) body += sections[(i + family) % sections.length];
  body = body.slice(0, bodyUnits);
  const parentIndexes = index < 64 ? (index ? [Math.floor((index - 1) / 4)] : [])
    : value % 5 === 0 ? [0] : [value % 64];
  if (index >= 64 && value % 13 === 0 && !parentIndexes.includes(1)) parentIndexes.push(1);
  const workstreamIndexes = value % 10 === 0 ? [] : [family % 64];
  if (value % 11 === 0 && workstreamIndexes.length) workstreamIndexes.push((family + 7) % 64);
  return { title, body, reference, family, bodyUnits, parentIndexes, workstreamIndexes,
    status: value % 7 === 0 ? 'closed' : 'open' };
}

export function workloadDigest(seed, count) {
  const hash = createHash('sha256');
  const bodyHistogram = {};
  let bodyUnits = 0, parentEdges = 0, membershipEdges = 0, closedTopics = 0;
  for (let i = 0; i < count; i++) {
    const topic = realisticTopic(seed, i);
    hash.update(JSON.stringify(topic));
    bodyHistogram[topic.bodyUnits] = (bodyHistogram[topic.bodyUnits] ?? 0) + 1;
    bodyUnits += topic.body.length;
    parentEdges += topic.parentIndexes.length;
    membershipEdges += topic.workstreamIndexes.length;
    closedTopics += Number(topic.status === 'closed');
  }
  return { sha256: hash.digest('hex'), bodyHistogram, bodyUnits, parentEdges, membershipEdges, closedTopics };
}

export function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function responseDigest(value) {
  if (Array.isArray(value)) return value.map(responseDigest);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'timings')
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, responseDigest(item)]));
  }
  return value;
}
