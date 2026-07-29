/**
 * Unit tests for the pure deep-link enrichment pass (WM 13.0.2
 * `feature-friendly-wm-links`). Covers each kind's icon, the count rules,
 * `0`-omission, `#`-label suppression, fenced-code skip, alert skip, the
 * already-iconned skip, and dangling-ref graceful degradation.
 */

import { describe, it, expect } from 'vitest';
import {
  enrichDeepLinks,
  DEEP_LINK_FALLBACK_ICON,
  type DeepLinkContext,
} from '../src/documentRenderers/enrichDeepLinks';

/** A fully-populated context so each kind resolves a real icon + count. */
function makeCtx(overrides: Partial<DeepLinkContext> = {}): DeepLinkContext {
  return {
    topicTypeIcon: (slug) => (slug === 'feature' ? 'rocket' : DEEP_LINK_FALLBACK_ICON),
    topicTypeOf: (slug) => (slug === 'my-topic' ? 'feature' : null),
    topicChildCount: (slug) => (slug === 'my-topic' ? 3 : 0),
    workstreamTopicCount: (slug) => (slug === 'my-ws' ? 2 : 0),
    ...overrides,
  };
}

const OPEN = 'vscode://kubarycz.working-memory/open';

describe('enrichDeepLinks', () => {
  it('topic link: prepends the topic-type icon and appends the child count', () => {
    const md = `[My Topic](${OPEN}/topic/my-topic)`;
    const out = enrichDeepLinks(md, makeCtx());
    expect(out).toBe(
      `[<span class="codicon codicon-rocket"></span> My Topic (3)](${OPEN}/topic/my-topic)`,
    );
  });

  it('topic link with no children: omits the (0) count but keeps the icon', () => {
    const md = `[Lonely](${OPEN}/topic/lonely)`;
    const ctx = makeCtx({
      topicTypeOf: (s) => (s === 'lonely' ? 'feature' : null),
      topicChildCount: () => 0,
    });
    const out = enrichDeepLinks(md, ctx);
    expect(out).toBe(
      `[<span class="codicon codicon-rocket"></span> Lonely](${OPEN}/topic/lonely)`,
    );
  });

  it('topic link with an unknown topic-type: falls back to symbol-misc', () => {
    const md = `[Orphan](${OPEN}/topic/orphan)`;
    const ctx = makeCtx({ topicTypeOf: () => null, topicChildCount: () => 0 });
    const out = enrichDeepLinks(md, ctx);
    expect(out).toBe(
      `[<span class="codicon codicon-${DEEP_LINK_FALLBACK_ICON}"></span> Orphan](${OPEN}/topic/orphan)`,
    );
  });

  it('workstream link: uses the fixed repo icon and the topic count', () => {
    const md = `[My WS](${OPEN}/workstream/my-ws)`;
    const out = enrichDeepLinks(md, makeCtx());
    expect(out).toBe(
      `[<span class="codicon codicon-repo"></span> My WS (2)](${OPEN}/workstream/my-ws)`,
    );
  });

  it('workstream link whose label starts with #: suppresses the count', () => {
    const md = `[#42](${OPEN}/workstream/my-ws)`;
    const out = enrichDeepLinks(md, makeCtx());
    expect(out).toBe(
      `[<span class="codicon codicon-repo"></span> #42](${OPEN}/workstream/my-ws)`,
    );
  });

  it('topic-type link: uses the fixed tag icon and no count', () => {
    const md = `[Feature](${OPEN}/topic-type/feature)`;
    const out = enrichDeepLinks(md, makeCtx());
    expect(out).toBe(
      `[<span class="codicon codicon-tag"></span> Feature](${OPEN}/topic-type/feature)`,
    );
  });

  it('alert link: is left completely untouched (own status icon at render site)', () => {
    const md = `[<span class="codicon codicon-bell"></span> Alert](${OPEN}/alert/a1)`;
    expect(enrichDeepLinks(md, makeCtx())).toBe(md);
  });

  it('alert link without a pre-icon: still skipped by kind', () => {
    const md = `[Plain Alert](${OPEN}/alert/a1)`;
    expect(enrichDeepLinks(md, makeCtx())).toBe(md);
  });

  it('session link: dropped from enrichment entirely (not in the control plane)', () => {
    const md = `[Some Session](${OPEN}/session/abc-123)`;
    expect(enrichDeepLinks(md, makeCtx())).toBe(md);
  });

  it('already-iconned label: not double-iconned', () => {
    const md = `[<span class="codicon codicon-rocket"></span> My Topic (3)](${OPEN}/topic/my-topic)`;
    expect(enrichDeepLinks(md, makeCtx())).toBe(md);
  });

  it('links inside fenced code blocks (```) are untouched', () => {
    const md = [
      '```',
      `[My Topic](${OPEN}/topic/my-topic)`,
      '```',
      `[My Topic](${OPEN}/topic/my-topic)`,
    ].join('\n');
    const out = enrichDeepLinks(md, makeCtx());
    const lines = out.split('\n');
    // Inside the fence: unchanged.
    expect(lines[1]).toBe(`[My Topic](${OPEN}/topic/my-topic)`);
    // Outside the fence: enriched.
    expect(lines[3]).toBe(
      `[<span class="codicon codicon-rocket"></span> My Topic (3)](${OPEN}/topic/my-topic)`,
    );
  });

  it('links inside tilde-fenced code blocks (~~~) are untouched', () => {
    const md = ['~~~', `[My WS](${OPEN}/workstream/my-ws)`, '~~~'].join('\n');
    expect(enrichDeepLinks(md, makeCtx())).toBe(md);
  });

  it('dangling ref (slug not found): renders the link with the fallback icon and no count', () => {
    const md = `[Ghost](${OPEN}/topic/ghost)`;
    const ctx = makeCtx({
      topicTypeOf: () => null,
      topicChildCount: () => 0,
    });
    const out = enrichDeepLinks(md, ctx);
    expect(out).toBe(
      `[<span class="codicon codicon-${DEEP_LINK_FALLBACK_ICON}"></span> Ghost](${OPEN}/topic/ghost)`,
    );
    // The URL is preserved — the link is never broken.
    expect(out).toContain(`(${OPEN}/topic/ghost)`);
  });

  it('percent-encoded ids are decoded before lookup', () => {
    const md = `[Encoded](${OPEN}/topic/a%20b)`;
    const seen: string[] = [];
    const ctx = makeCtx({
      topicTypeOf: (s) => {
        seen.push(s);
        return null;
      },
      topicChildCount: (s) => {
        seen.push(s);
        return 0;
      },
    });
    enrichDeepLinks(md, ctx);
    expect(seen).toContain('a b');
  });

  it('multiple links on one line are all enriched', () => {
    const md = `[My Topic](${OPEN}/topic/my-topic) and [My WS](${OPEN}/workstream/my-ws)`;
    const out = enrichDeepLinks(md, makeCtx());
    expect(out).toContain('codicon-rocket');
    expect(out).toContain('codicon-repo');
    expect(out).toContain('My Topic (3)');
    expect(out).toContain('My WS (2)');
  });
});
