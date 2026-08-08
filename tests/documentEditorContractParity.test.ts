/**
 * WM 14.2.1: structural guard against the hand-copied webview↔host view-model
 * contract drifting. The Svelte webview (`webview-ui/src/lib/types.ts`) and the
 * extension host (`src/webview/documentEditorProvider.ts`) are separate TS
 * programs, each with its OWN copy of the document view-model shapes. TS
 * interfaces are erased at runtime, so this test parses the field names out of
 * both source files and asserts the shared VMs carry identical field sets. If
 * one side gains or loses a field, this fails loudly.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hostSource = readFileSync(
  fileURLToPath(new URL('../src/webview/documentEditorProvider.ts', import.meta.url)),
  'utf8',
);
const webviewSource = readFileSync(
  fileURLToPath(new URL('../webview-ui/src/lib/types.ts', import.meta.url)),
  'utf8',
);

/** Extract the top-level field names of `interface <name> { … }` from source. */
function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} {`);
  if (start === -1) {
    throw new Error(`interface ${name} not found`);
  }
  let depth = 0;
  let body = '';
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      if (depth === 1) {
        continue;
      }
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        break;
      }
    }
    body += ch;
  }
  const fields: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
    if (m) {
      fields.push(m[1]);
    }
  }
  return fields.sort();
}

// The VMs that exist on BOTH sides of the postMessage contract.
const SHARED_VMS = [
  'WorkstreamTopicVM',
  'TreeActionVM',
  'TreeNaniteVM',
  'TreeTopicVM',
  'TreeGroupVM',
  'WorkstreamVM',
  'RelationVM',
  'AlertVM',
  'TopicTypeMetaVM',
  'TopicVM',
  'GenericFieldVM',
  'GenericDocVM',
];

describe('webview↔host document VM contract parity', () => {
  test.each(SHARED_VMS)('%s has identical fields on both sides', (name) => {
    const host = interfaceFields(hostSource, name);
    const webview = interfaceFields(webviewSource, name);
    expect(host).toEqual(webview);
  });

  test('the shared VM list is non-trivial (sanity)', () => {
    // Guard against interfaceFields silently returning empty and passing.
    expect(interfaceFields(hostSource, 'TopicVM').length).toBeGreaterThan(5);
  });
});
