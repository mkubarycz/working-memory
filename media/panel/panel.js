// @ts-check
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @typedef {{ command: string, title: string, args?: unknown[] }} Action */
  /** @typedef {{ kind: string, id: string, label: string, description?: string,
   *              tooltip?: string, icon?: string, openUri?: string,
   *              actions?: Action[], children?: any[], collapsible?: boolean }} Node */
  /** @typedef {{ tab: 'active'|'archive', workstreams: Node[],
   *              emptyMessage: string }} TabData */

  // --- Icons (inline SVG, currentColor) ---------------------------------

  const ICONS = {
    // Approximation of codicon `repo` — a book/repo glyph.
    repo:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="currentColor" d="M4 1h9v13H4.5a1.5 1.5 0 0 0-1.5 1.5V2.5A1.5 1.5 0 0 1 4.5 1H4zm.5 1A.5.5 0 0 0 4 2.5v9.55a2.5 2.5 0 0 1 .5-.05H12V2H4.5zM4 14h8v-1H4.5a.5.5 0 0 0 0 1H4z"/>' +
      '</svg>',
    // Approximation of codicon `symbol-keyword` — a hash glyph.
    'symbol-keyword':
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="currentColor" d="M6.5 2 6 5H3v1h2.83l-.5 4H2v1h3.16l-.5 3h1.01l.5-3h3.99l-.5 3h1l.5-3H14v-1h-2.66l.5-4H15V5h-2.97l.47-3h-1.01l-.47 3H7.01l.5-3H6.5zm.34 4h3.99l-.5 4H6.34l.5-4z"/>' +
      '</svg>',
    // Approximation of codicon `symbol-key` — a key glyph.
    'symbol-key':
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="currentColor" d="M10.5 1a4.5 4.5 0 0 0-4.41 5.41L1 11.5V15h3.5l.75-.75v-1.5h1.5l.75-.75v-1.5h1.5l.84-.84A4.5 4.5 0 1 0 10.5 1zm0 1a3.5 3.5 0 1 1-1.13 6.81l-.32.32-.95.95H6.5l-.75.75v1.5l-.75.75H4v.5H2v-2l5.06-5.06A3.5 3.5 0 0 1 10.5 2zm1.5 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>' +
      '</svg>',
    // Generic right-pointing chevron used for tree twisties.
    chevron:
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="currentColor" d="M6 4l4 4-4 4V4z"/>' +
      '</svg>',
    // Codicon-style `…` glyph for the per-row actions button.
    'more-actions':
      '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="currentColor" d="M4 8a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zm5.25 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zm5.25 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0z"/>' +
      '</svg>',
  };

  // --- State ------------------------------------------------------------

  const persisted =
    /** @type {{ activeTab?: 'active'|'archive', expanded?: string[] } | undefined} */ (
      vscode.getState()
    );

  /** @type {{ activeTab: 'active'|'archive', expanded: Set<string>,
   *           data: { active?: TabData, archive?: TabData },
   *           focusedId: string | null }} */
  const state = {
    activeTab: persisted?.activeTab === 'archive' ? 'archive' : 'active',
    expanded: new Set(Array.isArray(persisted?.expanded) ? persisted.expanded : []),
    data: {},
    focusedId: null,
  };

  function persist() {
    vscode.setState({
      activeTab: state.activeTab,
      expanded: Array.from(state.expanded),
    });
  }

  // --- Rendering --------------------------------------------------------

  const listEl = /** @type {HTMLElement} */ (document.getElementById('list'));
  const tabsEl = /** @type {HTMLElement} */ (document.querySelector('.tabs'));

  function iconSvg(name) {
    return ICONS[name] || '';
  }

  /**
   * @param {Node} node
   * @param {number} depth
   * @param {DocumentFragment} frag
   */
  function renderNode(node, depth, frag) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'treeitem');
    row.dataset.id = node.id;
    if (node.tooltip) {
      row.title = node.tooltip;
    }
    row.style.paddingLeft = (depth * 12 + 4) + 'px';
    if (state.focusedId === node.id) {
      row.classList.add('focused');
    }

    const hasChildren =
      Array.isArray(node.children) && node.children.length > 0;
    const expanded = state.expanded.has(node.id);

    // Twisty
    const twisty = document.createElement('span');
    twisty.className = 'twisty' + (hasChildren ? ' collapsible' : ' leaf') +
      (expanded ? ' expanded' : '');
    twisty.innerHTML = iconSvg('chevron');
    if (hasChildren) {
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle(node.id);
      });
    }
    row.appendChild(twisty);

    // Icon
    if (node.icon) {
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.innerHTML = iconSvg(node.icon);
      row.appendChild(icon);
    }

    // Label
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.label;
    row.appendChild(label);

    // Description
    if (node.description) {
      const desc = document.createElement('span');
      desc.className = 'description';
      desc.textContent = node.description;
      row.appendChild(desc);
    }

    // Actions
    if (Array.isArray(node.actions) && node.actions.length > 0) {
      const actions = document.createElement('span');
      actions.className = 'actions';
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.type = 'button';
      btn.title = 'More actions…';
      btn.setAttribute('aria-label', 'More actions');
      btn.innerHTML = iconSvg('more-actions');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: 'actions',
          nodeId: node.id,
          actions: node.actions,
        });
      });
      actions.appendChild(btn);
      row.appendChild(actions);
    }

    // Click / activation
    row.addEventListener('click', () => {
      state.focusedId = node.id;
      if (node.openUri) {
        vscode.postMessage({ type: 'open', uri: node.openUri });
      } else if (hasChildren) {
        toggle(node.id);
      } else {
        render();
      }
    });

    frag.appendChild(row);

    if (hasChildren && expanded) {
      for (const child of node.children) {
        renderNode(child, depth + 1, frag);
      }
    }
  }

  function toggle(id) {
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
    } else {
      state.expanded.add(id);
    }
    persist();
    render();
  }

  function render() {
    // Tabs
    const tabButtons = tabsEl.querySelectorAll('.tab');
    tabButtons.forEach((btn) => {
      const t = btn.getAttribute('data-tab');
      const selected = t === state.activeTab;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    });

    // List
    listEl.replaceChildren();
    const data = state.data[state.activeTab];
    if (!data || data.workstreams.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = data ? data.emptyMessage : '';
      listEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const ws of data.workstreams) {
      renderNode(ws, 0, frag);
    }
    listEl.appendChild(frag);
  }

  // --- Event wiring -----------------------------------------------------

  tabsEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = target.closest('.tab');
    if (!btn) {
      return;
    }
    const t = btn.getAttribute('data-tab');
    if (t !== 'active' && t !== 'archive') {
      return;
    }
    if (state.activeTab === t) {
      return;
    }
    state.activeTab = t;
    state.focusedId = null;
    persist();
    render();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg.type === 'data') {
      // Drop expanded ids that no longer exist in the new dataset to keep
      // the Set from growing unbounded across many refreshes.
      /** @type {Set<string>} */
      const liveIds = new Set();
      const visit = (n) => {
        liveIds.add(n.id);
        if (Array.isArray(n.children)) {
          for (const c of n.children) {
            visit(c);
          }
        }
      };
      for (const tab of /** @type {const} */ (['active', 'archive'])) {
        const td = msg.data?.[tab];
        if (td?.workstreams) {
          for (const w of td.workstreams) {
            visit(w);
          }
        }
      }
      for (const id of Array.from(state.expanded)) {
        if (!liveIds.has(id)) {
          state.expanded.delete(id);
        }
      }
      state.data = msg.data || {};
      render();
    }
  });

  // Request initial data.
  vscode.postMessage({ type: 'ready' });
})();
