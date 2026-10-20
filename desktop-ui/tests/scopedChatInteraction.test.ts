import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { describe, expect, it, vi } from 'vitest';
import { collapseChatOnInteraction } from '../src/renderer/scopedChat';

const source = readFileSync(resolve(import.meta.dirname, '../src/renderer/App.svelte'), 'utf8');
const ast = parse(source);

// Exercise the callbacks actually wired in App, without requiring Electron or a live control plane.
function interactionRegions() {
  const regions: Array<{ className: string; callback: string }> = [];
  function visit(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Element') {
      const action = node.attributes.find((attribute: any) =>
        attribute.type === 'Action' && attribute.name === 'collapseChatOnInteraction');
      if (action) {
        const className = node.attributes.find((attribute: any) => attribute.name === 'class').value[0].data;
        regions.push({ className, callback: source.slice(action.expression.start, action.expression.end) });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast.html);
  return regions;
}

describe('detailed chat outside interaction wiring', () => {
  it('limits interaction regions to the document stage and Active rail, excluding both chats and composer', () => {
    expect(interactionRegions().map((region) => region.className)).toEqual(['active-rail', 'stage-content']);
    expect(source).toContain('onclick={() => (scopePreviewExpanded = !scopePreviewExpanded)}');
    expect(source).toContain('class="scope-preview" class:expanded={scopePreviewExpanded}');
  });

  it.each(['pointerdown', 'keydown'])('collapses only details on %s and leaves the destination interaction intact', (type) => {
    for (const region of interactionRegions()) {
      const state = {
        scopePreviewExpanded: true,
        chatRailCollapsed: false,
        chatInput: 'Unsent draft',
        composerImages: [{ id: 'attachment' }],
        chatRuns: [
          { status: 'running', assistantText: 'Streaming response' },
          { status: 'awaiting_confirmation', pendingConfirmation: { id: 'approval' } },
        ],
      };
      const preserved = structuredClone(state);
      const node = new EventTarget();
      const collapse = runInNewContext(region.callback, state) as () => void;
      const action = collapseChatOnInteraction(node as HTMLElement, collapse);
      const destination = vi.fn();
      node.addEventListener(type, destination);
      const event = new Event(type, { cancelable: true });
      node.dispatchEvent(event);
      expect(state).toEqual({ ...preserved, scopePreviewExpanded: false });
      expect(destination).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
      action.destroy();
    }
  });

  it('uses capture so Markdown editors and other controls cannot swallow the collapse interaction', () => {
    const node = new EventTarget();
    const listen = vi.spyOn(node, 'addEventListener');
    const collapse = vi.fn();
    const action = collapseChatOnInteraction(node as HTMLElement, collapse);
    expect(listen).toHaveBeenCalledWith('pointerdown', collapse, { capture: true });
    expect(listen).toHaveBeenCalledWith('keydown', collapse, { capture: true });
    action.destroy();
  });

  it('ignores background updates, scrolling, and programmatic focus, and removes listeners on unmount', () => {
    const node = new EventTarget();
    const collapse = vi.fn();
    const action = collapseChatOnInteraction(node as HTMLElement, collapse);
    for (const type of ['input', 'change', 'focusin', 'scroll', 'document-change']) {
      node.dispatchEvent(new Event(type));
    }
    expect(collapse).not.toHaveBeenCalled();
    action.destroy();
    node.dispatchEvent(new Event('pointerdown'));
    node.dispatchEvent(new Event('keydown'));
    expect(collapse).not.toHaveBeenCalled();
  });
});
