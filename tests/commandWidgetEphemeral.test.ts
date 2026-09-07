import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = path.resolve(__dirname, '..');
const provider = readFileSync(path.join(root, 'src/webview/commandWidgetProvider.ts'), 'utf8');
const widget = readFileSync(path.join(root, 'webview-ui/src/lib/CommandWidget.svelte'), 'utf8');
const protocol = readFileSync(path.join(root, 'webview-ui/src/lib/types.ts'), 'utf8');

describe('ephemeral command widget contract', () => {
  test('retains command execution and live transcript rendering', () => {
    expect(provider).toContain("msg.type === 'submitCommand'");
    expect(provider).toContain('runToolLoop({');
    expect(widget).toContain("transport.post({ type: 'submitCommand'");
    expect(widget).toContain("msg.type === 'brief'");
  });

  test('does not persist, hydrate, replay, or open command records', () => {
    const combined = `${provider}\n${widget}\n${protocol}`;
    expect(combined).not.toMatch(/CommandJournal|commandJournal/);
    expect(combined).not.toContain("type: 'hydrate'");
    expect(combined).not.toContain('attachJournalId');
    expect(combined).not.toContain('openJournal');
  });
});