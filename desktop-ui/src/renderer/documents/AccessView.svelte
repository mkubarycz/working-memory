<script lang="ts">
  import { onMount } from 'svelte';
  import type { InstanceAccessAction, InstanceAccessSnapshot, InstancePermissions } from '../../shared/instanceIdentity';
  type Row = { id: string; label: string; target: 'request' | 'client'; permissions: InstancePermissions;
    status: string; expiresAt: number; editable: boolean; pending: boolean; revocable: boolean };
  const categories = ['content', 'settings', 'tools'] as const;
  const operations = ['create', 'read', 'update', 'delete', 'run'] as const;
  const labels = { content: 'Content', settings: 'Settings', tools: 'Tools' };
  let snapshot = $state<InstanceAccessSnapshot | null>(null);
  let error = $state('');
  let pollError = $state('');
  let busy = $state(false);
  let editing = $state<Row | null>(null);
  let dialog: HTMLDialogElement;
  let active = false;
  let generation = 0;
  let refreshing = false;
  const permissionRequests = $derived((snapshot?.requests ?? []).filter(request =>
    request.purpose === 'permissions' && request.state === 'pending' && request.expiresAt > Date.now()));
  const rows = $derived.by((): Row[] => {
    const now = Date.now();
    const requests = (snapshot?.requests ?? []).filter(request => request.purpose !== 'permissions'
      && (!request.clientId || request.expiresAt > now && request.state !== 'denied'));
    const renewing = new Set(requests.map(request => request.clientId));
    return [
      ...requests.map(request => ({
        ...request, target: 'request' as const, editable: request.expiresAt > now && request.state !== 'denied',
        pending: request.state === 'pending' && request.expiresAt > now, revocable: false,
        status: request.state === 'denied' ? 'Denied' : request.expiresAt <= now ? 'Expired'
          : request.state === 'approved' ? 'Awaiting claim' : request.clientId ? 'Renewal pending' : 'Pending',
      })),
      ...(snapshot?.clients ?? []).filter(client => !renewing.has(client.id)).map(client => ({
        ...client, target: 'client' as const, editable: client.revokedAt === null && client.expiresAt > now,
        pending: false, revocable: client.revokedAt === null,
        status: client.revokedAt !== null ? 'Revoked' : client.expiresAt <= now ? 'Expired' : 'Active',
      })),
    ];
  });
  function summary(permissions: InstancePermissions): string {
    return categories.map(category => {
      const granted = operations.filter(operation => operation === 'run'
        ? category === 'tools' && permissions.tools.run : permissions[category][operation]);
      return granted.length ? `${labels[category]}: ${granted.map(operation => operation === 'run' ? '+Run' : operation[0].toUpperCase()).join('')}` : '';
    }).filter(Boolean).join(' · ') || 'None';
  }
  function requestedAccess(permissions: InstancePermissions): string {
    return categories.flatMap(category => operations
      .filter(operation => operation === 'run' ? category === 'tools' && permissions.tools.run : permissions[category][operation])
      .map(operation => `${operation[0].toUpperCase() + operation.slice(1)} (${labels[category]})`)).join(', ');
  }
  async function refresh(): Promise<void> {
    if (refreshing || busy) return;
    refreshing = true;
    const current = generation;
    try {
      const result = await window.workingMemory.getInstanceAccess();
      if (active && current === generation) {
        snapshot = result;
        pollError = '';
        if (editing) {
          const updated = (editing.target === 'client' ? result.clients : result.requests).find(row => row.id === editing?.id);
          if (updated) editing = { ...editing, permissions: structuredClone(updated.permissions) };
          else { dialog.close(); editing = null; error = 'Client changed. Reopen permissions.'; }
        }
      }
    } catch (cause) {
      if (active && current === generation) pollError = cause instanceof Error ? cause.message : String(cause);
    } finally { refreshing = false; }
  }
  async function review(action: InstanceAccessAction): Promise<boolean> {
    busy = true;
    generation += 1;
    error = '';
    try {
      const result = await window.workingMemory.reviewInstanceAccess(action);
      if (active) snapshot = result;
      return true;
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally { busy = false; }
  }
  function openPermissions(row: Row): void {
    editing = { ...row, permissions: structuredClone($state.snapshot(row.permissions)) };
    error = '';
    dialog.showModal();
  }
  async function changePermission(category: typeof categories[number], operation: typeof operations[number], checked: boolean): Promise<void> {
    if (!editing || busy || operation === 'run' && category !== 'tools') return;
    const before = structuredClone($state.snapshot(editing));
    const next = structuredClone(before.permissions);
    if (operation === 'run') next.tools.run = checked;
    else next[category][operation] = checked;
    editing = { ...before, permissions: next };
    const saved = await review({ id: before.id, action: 'permissions', target: before.target, permissions: next });
    if (!saved) editing = before;
  }
  onMount(() => {
    active = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; generation += 1; clearInterval(timer); };
  });
</script>

<section aria-label="Instance access">
  {#each permissionRequests as request (request.id)}
    <div class="permission-request" role="group" aria-label="Permission request">
      <p><strong>{request.label}</strong> requests {requestedAccess(request.permissions)} access.</p>
      <div>
        <button disabled={busy} onclick={() => void review({ id: request.id, action: 'approve' })}>Approve</button>
        <button disabled={busy} onclick={() => void review({ id: request.id, action: 'deny' })}>Deny</button>
      </div>
    </div>
  {/each}
  <h2>Access</h2>
  <p class="muted">Approve clients you recognize. Access lasts 90 days; names are not verified.</p>
  {#if (error || pollError) && !editing}<p role="alert">{error || pollError}</p>{/if}
  <table>
    <thead><tr><th>Client</th><th>Access</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>
      {#each rows as row (`${row.target}:${row.id}`)}
        <tr>
          <td>{row.label}<small>{row.id}</small></td>
          <td><span>{summary(row.permissions)}</span>
            {#if row.editable}<button class="link" disabled={busy} onclick={() => openPermissions(row)}>Edit permissions</button>{/if}
          </td>
          <td>{row.status}<small>Expires {new Date(row.expiresAt).toLocaleString()}</small></td>
          <td>
            {#if row.pending}
              <button disabled={busy} onclick={() => void review({ id: row.id, action: 'approve' })}>Approve</button>
              <button disabled={busy} onclick={() => void review({ id: row.id, action: 'deny' })}>Deny</button>
            {:else if row.revocable}
              <button disabled={busy} onclick={() => void review({ id: row.id, action: 'revoke' })}>Revoke</button>
            {/if}
          </td>
        </tr>
      {:else}<tr><td colspan="4">{snapshot ? 'No clients yet.' : 'Loading...'}</td></tr>{/each}
    </tbody>
  </table>
</section>

<dialog bind:this={dialog} aria-labelledby="permissions-title"
  oncancel={event => { if (busy) event.preventDefault(); else editing = null; }}>
  {#if editing}
    <h2 id="permissions-title">{editing.label}</h2>
    <table aria-label="Client permissions">
      <thead><tr><th>Data</th>{#each operations as operation}<th>{operation[0].toUpperCase() + operation.slice(1)}</th>{/each}</tr></thead>
      <tbody>
        {#each categories as category}
          <tr><th>{labels[category]}</th>
            {#each operations as operation}
              <td>
                {#if operation !== 'run' || category === 'tools'}
                  <input type="checkbox" aria-label={`${labels[category]} ${operation}`} disabled={busy}
                    checked={operation === 'run' ? editing.permissions.tools.run : editing.permissions[category][operation]}
                    onchange={event => void changePermission(category, operation, event.currentTarget.checked)} />
                {:else}<span aria-hidden="true">-</span>{/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="muted">Passwords, secrets and access administration stay owner-only. Run also requires a script grant.</p>
    {#if error || pollError}<p role="alert">{error || pollError}</p>{/if}
    <footer><span role="status">{busy ? 'Saving...' : 'Changes apply immediately.'}</span>
      <button disabled={busy} onclick={() => { dialog.close(); editing = null; }}>Done</button>
    </footer>
  {/if}
</dialog>

<style>
  section { display: grid; gap: 12px; }
  .permission-request { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 12px; border: 1px solid var(--vscode-panel-border, #cbc7ca); border-radius: 6px; }
  .permission-request > div { display: flex; gap: 8px; }
  h2, p { margin: 0; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border, #444); vertical-align: top; }
  small, .muted { display: block; color: var(--desktop-chat-muted); overflow-wrap: anywhere; }
  .link { display: block; border: 0; background: none; padding: 4px 0; color: var(--vscode-textLink-foreground, #3794ff); text-decoration: underline; }
  dialog { width: min(620px, 90vw); border: 1px solid var(--vscode-panel-border, #d1ced0); border-radius: 8px; padding: 20px; color: var(--vscode-foreground, #262326); background: var(--vscode-editor-background, #faf9f7); }
  dialog::backdrop { background: #0008; }
  dialog h2, dialog table, dialog p { margin-bottom: 16px; }
  dialog th, dialog td { vertical-align: middle; }
  dialog thead th:not(:first-child), dialog td { text-align: center; }
  dialog input[type="checkbox"] { display: block; width: 16px; height: 16px; margin: 0 auto; padding: 0; }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  [role="alert"] { color: var(--vscode-errorForeground, #f48771); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
