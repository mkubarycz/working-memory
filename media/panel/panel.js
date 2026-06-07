// @ts-check
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @typedef {{ command: string, title: string, args?: unknown[] }} Action */
  /** @typedef {{ kind: string, id: string, label: string, description?: string,
   *              tooltip?: string, icon?: string, openUri?: string,
   *              actions?: Action[], children?: any[], collapsible?: boolean,
   *              status?: 'open'|'closed' }} Node */
  /** @typedef {{ tab: 'active'|'archive'|'topics', items: Node[],
   *              emptyMessage: string }} TabData */

  /**
   * Deterministically map a workstream node id to one of the card color
   * slots (0..3 → red/blue/green/yellow). Stable across reloads so each
   * workstream keeps the same color.
   * @param {string} id
   * @returns {number}
   */
  function colorIndexForId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (h * 31 + id.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 4;
  }

  // --- Icons ------------------------------------------------------------
  //
  // The webview loads the official VS Code codicon font (`media/codicons/`,
  // see panelProvider.ts → renderHtml). Any codicon id from
  // https://microsoft.github.io/vscode-codicons/dist/codicon.html
  // can be rendered as `<span class="codicon codicon-<name>"></span>`.
  // Missing/empty names render nothing — no broken-glyph fallback.

  /**
   * Build a codicon span element for the given name.
   * @param {string | undefined | null} name
   * @returns {HTMLElement | null}
   */
  function makeCodicon(name) {
    if (!name) {
      return null;
    }
    const el = document.createElement('span');
    el.className = 'codicon codicon-' + name;
    return el;
  }

  // --- State ------------------------------------------------------------

  const persisted =
    /** @type {{ activeTab?: 'active'|'archive'|'topics', expanded?: string[] } | undefined} */ (
      vscode.getState()
    );

  /** @type {{ activeTab: 'active'|'archive'|'topics', expanded: Set<string>,
   *           data: { active?: TabData, archive?: TabData, topics?: TabData },
   *           focusedId: string | null }} */
  const state = {
    activeTab:
      persisted?.activeTab === 'archive' || persisted?.activeTab === 'topics'
        ? persisted.activeTab
        : 'active',
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

  /**
   * Build the row element for a node — no children, no recursion. Returned
   * element is detached; caller decides where to put it.
   * @param {Node} node
   * @param {number} depth
   * @returns {HTMLElement}
   */
  function renderRow(node, depth) {
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
    // Mute closed topic rows so the eye skips past them. Children render as
    // sibling DOM rows (not nested), so this opacity does not bleed into
    // open child topics under a closed parent.
    if (
      (node.kind === 'topic' || node.kind === 'topic-row') &&
      node.status === 'closed'
    ) {
      row.classList.add('is-closed');
    }

    const hasChildren =
      Array.isArray(node.children) && node.children.length > 0;
    const expanded = state.expanded.has(node.id);

    // Twisty — chevron-right that we rotate 90° via CSS when expanded.
    const twisty = document.createElement('span');
    twisty.className = 'twisty' + (hasChildren ? ' collapsible' : ' leaf') +
      (expanded ? ' expanded' : '');
    const twistyIcon = makeCodicon('chevron-right');
    if (twistyIcon) {
      twisty.appendChild(twistyIcon);
    }
    if (hasChildren) {
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle(node.id);
      });
    }
    row.appendChild(twisty);

    // Icon
    if (node.icon) {
      const wrap = document.createElement('span');
      wrap.className = 'icon';
      const iconEl = makeCodicon(node.icon);
      if (iconEl) {
        wrap.appendChild(iconEl);
      }
      row.appendChild(wrap);
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
      const moreIcon = makeCodicon('ellipsis');
      if (moreIcon) {
        btn.appendChild(moreIcon);
      }
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

    return row;
  }

  /**
   * Append a row plus its expanded subtree to a target element/fragment.
   * @param {Node} node
   * @param {number} depth
   * @param {HTMLElement | DocumentFragment} target
   */
  function renderNode(node, depth, target) {
    target.appendChild(renderRow(node, depth));
    const hasChildren =
      Array.isArray(node.children) && node.children.length > 0;
    if (hasChildren && state.expanded.has(node.id)) {
      for (const child of node.children) {
        renderNode(child, depth + 1, target);
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
    listEl.classList.toggle('cards', state.activeTab === 'active');
    const data = state.data[state.activeTab];
    if (!data || data.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = data ? data.emptyMessage : '';
      listEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    if (state.activeTab === 'active') {
      // Each top-level workstream renders as its own collapsible card.
      // Header is the workstream row itself; body holds the nested subtree.
      for (const item of data.items) {
        const card = document.createElement('div');
        card.className = 'ws-card ws-card-color-' + colorIndexForId(item.id);
        const expanded = state.expanded.has(item.id);
        if (expanded) {
          card.classList.add('expanded');
        }

        const header = document.createElement('div');
        header.className = 'ws-card-header';
        header.appendChild(renderRow(item, 0));
        card.appendChild(header);

        const hasChildren =
          Array.isArray(item.children) && item.children.length > 0;
        if (hasChildren) {
          const body = document.createElement('div');
          body.className = 'ws-card-body';
          if (!expanded) {
            body.hidden = true;
          } else {
            for (const child of item.children) {
              renderNode(child, 1, body);
            }
          }
          card.appendChild(body);
        }

        frag.appendChild(card);
      }
    } else {
      for (const item of data.items) {
        renderNode(item, 0, frag);
      }
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
    if (t !== 'active' && t !== 'archive' && t !== 'topics') {
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
      for (const tab of /** @type {const} */ (['active', 'archive', 'topics'])) {
        const td = msg.data?.[tab];
        if (td?.items) {
          for (const w of td.items) {
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
