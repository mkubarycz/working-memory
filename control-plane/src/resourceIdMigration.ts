import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

interface LegacyResource {
  id: string;
  kind: string;
  slug: string | null;
  spec: string;
  deleted_at: number | null;
}

/**
 * Append-only resource-store migration. Authored text and historical snapshots
 * are deliberately not rewritten; only typed resource references are converted.
 */
export interface ResourceIdUpgradeOptions {
  /** Explicit maintenance operation, never enabled by normal startup/rendering. */
  repairLegacyData?: boolean;
  dryRun?: boolean;
}

export interface ResourceIdUpgradeResult {
  repairedLinks: number;
  issues: Array<{ risk: 'high' | 'medium'; id: string; field: string; detail: string }>;
  reportId?: string;
  workstreamId?: string;
}

const resourceKinds: Record<string, string> = {
  topic: 'Topic', workstream: 'Workstream', 'topic-type': 'TopicType', alert: 'AgentMessage',
  'agent-message': 'AgentMessage', 'container-app': 'ContainerClaim', config: 'Config',
};

export function migrateResourceIds(db: DatabaseSync, options: ResourceIdUpgradeOptions = {}): ResourceIdUpgradeResult {
  const result: ResourceIdUpgradeResult = { repairedLinks: 0, issues: [] };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS resource_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL)');
    const done = db.prepare("SELECT version FROM resource_migrations WHERE name = 'resource-ids'").get() as { version: number } | undefined;
    if (done) {
      if (done.version !== 1) throw new Error(`Unsupported resource-ids migration version: ${done.version}`);
      db.exec('COMMIT');
      return result;
    }
    const columns = db.prepare('PRAGMA table_info(resources)').all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'slug')) {
      const rows = db.prepare('SELECT id, kind, slug, spec, deleted_at FROM resources ORDER BY rowid').all() as unknown as LegacyResource[];
      const find = (kind: string | undefined, value: string) => {
        const candidates = rows.filter((row) => (!kind || row.kind === kind) && (row.id === value || row.slug === value));
        const live = candidates.filter((row) => row.deleted_at === null);
        const matches = live.length ? live : candidates;
        return matches.length === 1 ? matches[0] : undefined;
      };
      const issue = (id: string, field: string, detail: string, risk: 'high' | 'medium' = 'high') => {
        result.issues.push({ id, field, detail, risk });
      };
      const resolve = (kind: string, value: unknown, owner: string): string => {
        if (typeof value !== 'string' || !value) throw new Error(`${owner}: invalid ${kind} reference ${JSON.stringify(value)}`);
        const byId = rows.find((row) => row.kind === kind && row.id === value);
        const byName = rows.filter((row) => row.kind === kind && row.slug === value);
        const candidates = byName.filter((row) => row.deleted_at === null);
        const matches = candidates.length ? candidates : byName;
        if (byId && matches.every((row) => row.id === byId.id)) return byId.id;
        if (!byId && matches.length === 1) return matches[0].id;
        throw new Error(`${owner}: ${matches.length || byId ? 'ambiguous' : 'missing'} ${kind} reference "${value}". Repair this reference before upgrading; no data was changed.`);
      };
      const references = (spec: Record<string, unknown>, field: string, kind: string, owner: string) => {
        if (spec[field] === undefined) return;
        if (!Array.isArray(spec[field])) throw new Error(`${owner}: ${field} must be an array`);
        spec[field] = spec[field].flatMap((value) => {
          const target = typeof value === 'string' ? find(kind, value) : undefined;
          const liveOwner = rows.find((row) => row.id === owner)?.deleted_at === null;
          if (options.repairLegacyData && typeof value === 'string' && (!target || liveOwner && target.deleted_at !== null)) {
            issue(owner, field, `Detached ${target ? 'soft-deleted' : 'unresolved'} ${kind} reference: ${value}`);
            return [];
          }
          return [resolve(kind, value, `${owner}.${field}`)];
        });
      };
      const singleReference = (spec: Record<string, unknown>, field: string, kind: string, owner: string) => {
        if (spec[field] === undefined || spec[field] === null || spec[field] === '') return;
        if (options.repairLegacyData && typeof spec[field] === 'string' && !find(kind, spec[field])) {
          issue(owner, field, `Detached unresolved ${kind} reference: ${spec[field]}`);
          delete spec[field];
        } else {
          spec[field] = resolve(kind, spec[field], `${owner}.${field}`);
        }
      };
      const rewriteLinks = (value: unknown, owner: string, field: string): unknown => {
        if (typeof value === 'string') {
          return value.replace(
            /\b(?:working-memory:\/\/open\/|vscode:\/\/kubarycz\.working-memory\/open\/|https?:\/\/(?:localhost|127\.0\.0\.1):7718\/open\/)(topic|workstream|topic-type|alert|agent-message|document)\/([^\s<>()"'`\[\]?#]+)/g,
            (url, route: string, encoded: string) => {
              let identifier: string;
              try { identifier = decodeURIComponent(encoded); }
              catch { issue(owner, field, `Malformed internal URL: ${url}`, 'medium'); return url; }
              const target = find(resourceKinds[route], identifier);
              if (!target) {
                issue(owner, field, `Unresolved internal URL: ${url}`, 'medium');
                return url;
              }
              const replacement = `working-memory://open/${route === 'alert' ? 'agent-message' : route}/${encodeURIComponent(target.id)}`;
              if (replacement !== url) result.repairedLinks++;
              return replacement;
            },
          );
        }
        if (Array.isArray(value)) return value.map((item, i) => rewriteLinks(item, owner, `${field}[${i}]`));
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).map(([key, child]) =>
            [key, key === 'legacy_source' ? child : rewriteLinks(child, owner, `${field}.${key}`)]));
        }
        return value;
      };
      const scopeReference = (value: unknown, owner: string, field: string): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const { slug: _legacyName, ...ref } = value as Record<string, unknown>;
        const kind = typeof ref.kind === 'string' ? resourceKinds[ref.kind] ?? (rows.some((row) => row.kind === ref.kind) ? ref.kind : undefined) : undefined;
        if (kind && typeof ref.id === 'string') {
          const target = find(kind, ref.id);
          if (target) ref.id = target.id;
          else if (options.repairLegacyData) issue(owner, field, `Historical scope target is missing: ${kind}/${ref.id}`, 'medium');
          else resolve(kind, ref.id, `${owner}.${field}`);
        }
        return ref;
      };
      const update = db.prepare('UPDATE resources SET spec = ?, resource_version = ? WHERE id = ?');
      const maximum = db.prepare('SELECT COALESCE(MAX(resource_version), 0) AS version FROM resources').get() as { version: number };
      db.prepare("UPDATE store_meta SET value = MAX(value, ?) WHERE key = 'resource_version'").run(maximum.version);
      for (const row of rows) {
        let spec: Record<string, unknown> = JSON.parse(row.spec);
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${row.id}: spec must be an object`);
        if (row.kind === 'Topic') {
          references(spec, 'parents', 'Topic', row.id);
          references(spec, 'workstreams', 'Workstream', row.id);
          references(spec, 'focusedWorkstreams', 'Workstream', row.id);
          if (options.repairLegacyData && Array.isArray(spec.focusedWorkstreams)) {
            const membership = Array.isArray(spec.workstreams) ? spec.workstreams : [];
            const stale = spec.focusedWorkstreams.filter((value) => !membership.includes(value));
            if (stale.length) {
              issue(row.id, 'focusedWorkstreams', `Removed focus outside workstream membership: ${stale.join(', ')}`);
              spec.focusedWorkstreams = spec.focusedWorkstreams.filter((value) => membership.includes(value));
            }
          }
          if (options.repairLegacyData && typeof spec.topicType === 'string' && !find('TopicType', spec.topicType)) {
            const defaults = rows.filter((candidate) => candidate.kind === 'TopicType' && candidate.deleted_at === null && JSON.parse(candidate.spec).label === 'Topic');
            if (defaults.length !== 1) throw new Error('Missing or ambiguous general Topic type; cannot repair topicType safely.');
            issue(row.id, 'topicType', `Replaced missing type "${spec.topicType}" with general Topic type (${defaults[0].id}).`);
            spec.topicType = defaults[0].id;
          } else if (spec.topicType !== undefined) spec.topicType = resolve('TopicType', spec.topicType, `${row.id}.topicType`);
        }
        if (row.kind === 'AgentMessage' || row.kind === 'Alert') {
          references(spec, 'topics', 'Topic', row.id);
        }
        if (['JournalEntry', 'Nanite', 'NaniteJournal'].includes(row.kind)) {
          singleReference(spec, 'workstream', 'Workstream', row.id);
        }
        if (row.kind === 'JournalEntry') references(spec, 'topics', 'Topic', row.id);
        if (row.kind === 'Nanite' || row.kind === 'NaniteJournal') singleReference(spec, 'inputTopic', 'Topic', row.id);
        if (row.kind === 'Nanite') references(spec, 'configs', 'Config', row.id);
        if (row.kind === 'CommandJournal') {
          // Pre-v2 journals used this field for Topic/Nanite scopes as well.
          if (typeof spec.workstream === 'string' && spec.workstream && spec.workstream !== '__global__') {
            const scope = find(undefined, spec.workstream);
            if (scope) spec.workstream = scope.id;
            else if (options.repairLegacyData) {
              issue(row.id, 'workstream', `Detached ambiguous historical scope: ${spec.workstream}`, 'medium');
              delete spec.workstream;
            } else throw new Error(`${row.id}: unresolved historical scope "${spec.workstream}".`);
          }
          spec.primaryScope = scopeReference(spec.primaryScope, row.id, 'primaryScope');
          if (spec.primaryScope === undefined) delete spec.primaryScope;
          if (Array.isArray(spec.entityRefs)) spec.entityRefs = spec.entityRefs.map((ref) => scopeReference(ref, row.id, 'entityRefs'));
          if (Array.isArray(spec.events)) {
            spec.events = spec.events.map((value) => {
              if (!value || typeof value !== 'object' || !('navigationTarget' in value)) return value;
              return { ...value, navigationTarget: scopeReference(value.navigationTarget, row.id, 'events.navigationTarget') };
            });
          }
        }
        if (options.repairLegacyData) spec = rewriteLinks(spec, row.id, 'spec') as Record<string, unknown>;
        db.prepare("UPDATE store_meta SET value = value + 1 WHERE key = 'resource_version'").run();
        const next = db.prepare("SELECT value FROM store_meta WHERE key = 'resource_version'").get() as { value: number };
        update.run(JSON.stringify(spec), next.value, row.id);
      }
      // DROP COLUMN avoids rebuilding the parent table and firing child cascades.
      const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'resources' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
      for (const index of indexes) {
        if (/\bslug\b/i.test(index.sql)) db.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
      }
      db.exec('ALTER TABLE resources DROP COLUMN slug');
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error('Resource-ID migration failed foreign-key integrity checks.');
      if (options.repairLegacyData) {
        const now = Math.floor(Date.now() / 1000);
        const workstreamId = randomUUID(), reportId = randomUUID();
        const type = rows.filter((row) => row.kind === 'TopicType' && row.deleted_at === null && JSON.parse(row.spec).label === 'Task');
        const general = rows.filter((row) => row.kind === 'TopicType' && row.deleted_at === null && JSON.parse(row.spec).label === 'Topic');
        const topicType = type.length === 1 ? type[0].id : general.length === 1 ? general[0].id : undefined;
        if (!topicType) throw new Error('Upgrade report requires one live Task or general Topic type.');
        const sections = ['# Resource-ID upgrade report', '', `Rewrote ${result.repairedLinks} internal URL occurrences to object IDs. Existing object IDs and lifecycle statuses were preserved.`, '', '## High risk: repaired structured references', '',
          ...result.issues.filter((item) => item.risk === 'high').map((item) => `- [Affected document](working-memory://open/document/${encodeURIComponent(item.id)}) — ${item.field}: ${item.detail}`),
          '', '## Medium risk: links and historical references requiring review', '',
          ...result.issues.filter((item) => item.risk === 'medium').map((item) => `- [Affected document](working-memory://open/document/${encodeURIComponent(item.id)}) — ${item.field}: ${item.detail}`),
          '', '## Operational review', '', 'Existing managed Docker containers retain their old ownership labels. Recreate those containers through a reviewed data-preserving upgrade before managing them by object ID. Existing container data volumes were not modified.', '', 'Historical legacy_source snapshots were preserved verbatim; their embedded URLs remain historical evidence, not active references.'];
        const insert = (id: string, kind: string, spec: Record<string, unknown>) => {
          db.prepare("UPDATE store_meta SET value = value + 1 WHERE key = 'resource_version'").run();
          const version = (db.prepare("SELECT value FROM store_meta WHERE key = 'resource_version'").get() as { value: number }).value;
          db.prepare(`INSERT INTO resources (id, kind, labels, spec, status, created_at, updated_at, deleted_at, resource_version)
            VALUES (?, ?, '{}', ?, '{}', ?, ?, NULL, ?)`).run(id, kind, JSON.stringify(spec), now, now, version);
        };
        insert(workstreamId, 'Workstream', { title: 'Upgrade to 1.3.0', status: 'progress', position: 0 });
        insert(reportId, 'Topic', { title: '1.3.0 resource-ID migration report', body: sections.join('\n'), status: 'open', topicType, parents: [], workstreams: [workstreamId], focusedWorkstreams: [workstreamId] });
        result.reportId = reportId;
        result.workstreamId = workstreamId;
      }
    }
    db.prepare("INSERT INTO resource_migrations (name, version) VALUES ('resource-ids', 1)").run();
    db.exec(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Resource-ID migration failed: ${(error as Error).message}`, { cause: error });
  }
}
