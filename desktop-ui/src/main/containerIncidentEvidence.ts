import { z } from 'zod';

const LOG_LIMIT = 4000;

/** Retain error categories and code locations, never arbitrary log messages or payloads. */
export function summarizeContainerLogs(raw: string): string {
  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  const retained: string[] = [];
  for (const line of lines) {
    const timestamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+/.exec(line);
    const text = timestamp ? line.slice(timestamp[0].length) : line;
    let detail: string | undefined;
    if (/FATAL ERROR:.*(?:heap out of memory|Reached heap limit|Ineffective mark-compacts)/.test(text)) {
      detail = 'V8 fatal error: JavaScript heap out of memory';
    } else {
      const error = /\b(TypeError|RangeError|ReferenceError|SyntaxError|AggregateError|SystemError|Error)(?: \[(ERR_[A-Z0-9_]+|SQLITE_[A-Z_]+)\])?:/.exec(text);
      const code = /\b(SQLITE_(?:BUSY|LOCKED|FULL|IOERR|CORRUPT|NOMEM|READONLY|CANTOPEN)|E(?:NOMEM|NOSPC|IO|BUSY|ACCES|PERM|CONNRESET|PIPE|TIMEDOUT))\b/.exec(text);
      const sqlite = /\b(database is locked|database or disk is full|disk I\/O error|database disk image is malformed)\b/.exec(text);
      const frame = /^\s*at (?:[^()\r\n]*\()?((?:\/app\/(?:out\/control-plane|node_modules)\/[\w/@.-]+\.(?:js|cjs|mjs)|node:[a-z_/]+):\d+:\d+)\)?$/.exec(text);
      const source = /^\[(control-plane|diagnostics|tool-queue|mcp-sessions|agent-message-reminders|host-tasks)\]/.exec(text);
      if (frame) detail = `at ${frame[1]}`;
      else if (error || code || sqlite || source) {
        detail = [source ? `[${source[1]}]` : '', error?.[1], error?.[2], code?.[1], sqlite?.[1]]
          .filter(Boolean).join(' ') || 'Backend runtime error logged';
        detail += ' (message omitted for privacy)';
      }
    }
    if (detail) retained.push(`${timestamp ? `${timestamp[1]} ` : ''}${detail}`);
  }
  const heading = `Container logs (last ${lines.length} returned lines; error categories and stack locations only):`;
  if (!retained.length) return `${heading}\nNo recognized error or stack location was found. Other log content is omitted for privacy; this does not prove there were no errors.`;
  const excerpt = retained.join('\n');
  return `${heading}\n${excerpt.length > LOG_LIMIT ? `[Earlier log evidence truncated]\n${excerpt.slice(-LOG_LIMIT)}` : excerpt}`;
}

export function summarizeContainerStats(raw: string): string {
  const record = z.record(z.string(), z.unknown());
  const parsed = z.union([record, z.array(record).length(1)]).parse(JSON.parse(raw));
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  const metric = (keys: string[], pattern: RegExp): string => {
    const value = keys.map(key => row[key]).find(value => value !== undefined);
    if (value === undefined) return 'unavailable';
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid container resource metric.');
    const text = String(value).trim();
    if (/^--(?:\s*\/\s*--)?$/.test(text)) return 'unavailable';
    if (!pattern.test(text)) throw new Error('Invalid container resource metric.');
    return text;
  };
  const percent = /^\d+(?:\.\d+)?%?$/;
  const bytes = /^\d+(?:\.\d+)?\s*(?:B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB))?$/;
  return `Container resource sample: CPU ${metric(['CPUPerc', 'CPU', 'cpu_percent'], percent)}; `
    + `memory ${metric(['MemUsage', 'mem_usage'], bytes)} (${metric(['MemPerc', 'mem_percent'], percent)}); `
    + `PIDs ${metric(['PIDs', 'PIDS', 'pids'], /^\d+$/)}; block I/O ${metric(['BlockIO', 'blocki'], bytes)}.`;
}
