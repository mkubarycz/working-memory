<script lang="ts">
  import { onMount } from 'svelte';
  import type { InstanceAccessSnapshot } from '../../shared/instanceIdentity';
  let snapshot = $state<InstanceAccessSnapshot | null>(null);
  let error = $state('');
  let busy = $state(false);
  let passwordHint = $state('');
  let active = true;
  async function refresh(): Promise<void> {
    try {
      const result = await window.workingMemory.getInstanceAccess();
      if (active) { snapshot = result; error = ''; }
    } catch (cause) { if (active) error = cause instanceof Error ? cause.message : String(cause); }
  }
  async function review(id: string, action: 'approve' | 'deny' | 'revoke'): Promise<void> {
    busy = true;
    error = '';
    try {
      const result = await window.workingMemory.reviewInstanceAccess({ id, action });
      if (active) snapshot = result;
    } catch (cause) { if (active) error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function savePasswordHint(): Promise<void> {
    busy = true;
    error = '';
    try { await window.workingMemory.setInstancePasswordHint(passwordHint); }
    catch (cause) { if (active) error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  onMount(() => {
    void refresh();
    void window.workingMemory.getInstanceIdentity().then(state => {
      if (active) passwordHint = state.passwordHint;
    }).catch(cause => { if (active) error = cause instanceof Error ? cause.message : String(cause); });
    const timer = setInterval(() => { if (!busy) void refresh(); }, 10000);
    return () => { active = false; clearInterval(timer); };
  });
</script>

<section aria-label="Instance access">
  <h2>Instance access</h2>
  <p>Signed in as instance owner. Agents request access through this instance's <code>/identity/v1/mcp</code> endpoint.
    Approve only requests you recognize. Client names are not verified identities.</p>
  <button disabled={busy} onclick={() => void refresh()}>Refresh access requests</button>
  {#if error}<p role="alert">{error}</p>{/if}
  <details>
    <summary>Edit password hint</summary>
    <form onsubmit={event => { event.preventDefault(); void savePasswordHint(); }}>
      <label>Password hint (optional)<textarea bind:value={passwordHint} maxlength="1000" rows="2"></textarea></label>
      <p>The hint is visible before sign-in. Use a reminder, not your password or other secrets.</p>
      <button disabled={busy}>Save password hint</button>
    </form>
  </details>
  <h3>Access requests</h3>
  <table>
    <thead><tr><th>Client</th><th>Access</th><th>Request</th><th>Review</th></tr></thead>
    <tbody>
      {#each snapshot?.requests ?? [] as request (request.id)}
        <tr>
          <td>{request.label}<small>{request.source} · {request.id}</small></td>
          <td>{request.access === 'write' ? 'Read and change data' : 'Read-only data'}</td>
          <td>{request.clientId ? 'Refresh' : 'New identity'}<small>Expires {new Date(request.expiresAt).toLocaleTimeString()}</small></td>
          <td>
            {#if request.state === 'approved'}
              Waiting for client to claim
            {:else}
              <button disabled={busy} onclick={() => void review(request.id, 'approve')}>Approve...</button>
              <button disabled={busy} onclick={() => void review(request.id, 'deny')}>Deny</button>
            {/if}
          </td>
        </tr>
      {:else}<tr><td colspan="4">No pending access requests.</td></tr>{/each}
    </tbody>
  </table>
  <p>Approved clients receive a private token valid for 12 hours. Refresh requires your approval again.
    Data access does not include owner administration or permission to execute host scripts.</p>
  <h3>Client identities</h3>
  <table>
    <thead><tr><th>Client</th><th>Access</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>
      {#each snapshot?.clients ?? [] as client (client.id)}
        <tr>
          <td>{client.label}<small>{client.id}</small></td>
          <td>{client.access === 'write' ? 'Read and change data' : 'Read-only data'}</td>
          <td>{client.revokedAt ? 'Revoked' : client.expiresAt <= Date.now() ? 'Expired' : `Expires ${new Date(client.expiresAt).toLocaleString()}`}</td>
          <td><button disabled={busy || !!client.revokedAt} onclick={() => void review(client.id, 'revoke')}>Revoke</button></td>
        </tr>
      {:else}<tr><td colspan="4">No client identities have been issued.</td></tr>{/each}
    </tbody>
  </table>
  <button disabled={busy} onclick={() => void window.workingMemory.signOutInstance().catch(cause => {
    error = cause instanceof Error ? cause.message : String(cause);
  })}>Sign out of this instance</button>
</section>

<style>
  section { display: grid; gap: 12px; }
  h2, h3, p { margin: 0; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border, #444); vertical-align: top; }
  small { display: block; color: var(--desktop-chat-muted); overflow-wrap: anywhere; }
  form, label { display: grid; gap: 8px; }
  [role="alert"] { color: var(--vscode-errorForeground, #f48771); }
</style>
