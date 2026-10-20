<script lang="ts">
  import { onMount } from 'svelte';
  import type { HostTaskDesktopState } from '../shared/hostTasks';
  import { HOST_TASK_SCOPE } from '../shared/hostTasks';

  let { onClose }: { onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let state = $state<HostTaskDesktopState | null>(null);
  let error = $state('');
  let busy = $state(false);
  let label = $state('');
  let instanceId = $state('');
  let appId = $state('');
  let windowsSid = $state('');
  let tenantId = $state('');
  let lifetime = $state('1');
  let now = $state(Date.now());

  async function refresh(): Promise<void> {
    state = await window.workingMemory.getHostTasks();
  }

  async function perform(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
      await refresh();
    } catch (cause) {
      state = null;
      error = cause instanceof Error ? cause.message : 'Host-task broker unavailable.';
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    dialog.showModal();
    void perform(async () => {});
    const timer = setInterval(() => { now = Date.now(); }, 15_000);
    return () => clearInterval(timer);
  });

</script>

<dialog bind:this={dialog} class="host-tasks" aria-labelledby="host-task-title"
  oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
  <header>
    <h2 id="host-task-title">Host tasks — trusted desktop approval</h2>
    <button disabled={busy} onclick={onClose} aria-label="Close host-task approvals">Close</button>
  </header>
  <p>
    Scope: read Thrive items created by or assigned to Michael <strong>OR</strong> under
    <strong>{HOST_TASK_SCOPE.areaPath}</strong> in {HOST_TASK_SCOPE.organization} / {HOST_TASK_SCOPE.project};
    <strong>every five minutes</strong>; <strong>no ADO writes</strong>.
    Manual runs must be bounded. Grants expire and can be revoked.
    This is constrained <strong>trusted host code, not a sandbox</strong>.
    Windows permissions, organization policy and Microsoft sign-in still apply.
  </p>
  <p>Tracked item count is scoped membership, not the count of all open task tickets.</p>
  <p>Allowed ADO scope: organization <strong>{HOST_TASK_SCOPE.organization}</strong>,
    project <strong>{HOST_TASK_SCOPE.project}</strong>, area <strong>{HOST_TASK_SCOPE.areaPath}</strong>,
    identity <strong>{HOST_TASK_SCOPE.identity}</strong>.</p>
  <p>Admin access is configured separately by <code>WM_HOST_TASK_ADMIN_TOKEN_FILE</code>.
    Never provision it through MCP or document CRUD. New Windows admin imports and app exports are blocked
    until private-file ACL verification is available; existing OS-encrypted credentials remain readable.</p>
  <div class="actions">
    <button disabled={busy} onclick={() => void perform(async () => {})}>Refresh status</button>
    <button disabled={busy || !!state?.adminProvisioningBlockedReason} onclick={() => void perform(() => window.workingMemory.provisionHostTaskAdmin())}>
      Import admin token (native file picker)
    </button>
  </div>
  {#if error}<p role="alert">{error} Status unavailable; no live runner is assumed.</p>{/if}
  {#if state}
    <p>Environment: <code>{state.environment}</code></p>
    <p role="status">{state.runnerBlockedReason}</p>
    {#if state.adminProvisioningBlockedReason}<p role="status">{state.adminProvisioningBlockedReason}</p>{/if}
    {#if !state.credentialReady}
      <p>Admin credential not provisioned. Import a private token file into OS-encrypted storage.</p>
    {/if}
    {#if state.snapshot}
      {@const snapshot = state.snapshot}
      {#if snapshot.executionBlockedReason}<p role="status">Broker: {snapshot.executionBlockedReason}</p>{/if}
      <h3>Broker operation policy</h3>
      <p>Capability {snapshot.policy.operation.capability}, version {snapshot.policy.operationVersion} ·
        <code>policyHash</code> (descriptor SHA-256) <code>{snapshot.policy.policyHash}</code> (not executable-byte verification)</p>
      <p>Actual executable bytes/publisher and current-user effective identity remain unverified. Execution stays disabled.</p>
      <p>Actions: {snapshot.policy.actions.join(', ')}. ADO fields: {snapshot.policy.operation.fields.join(', ')}.</p>
      <details><summary>Reviewed membership query</summary><pre class="policy-query">{snapshot.policy.operation.query}</pre></details>
      <p>Output schema {snapshot.policy.operation.resultSchemaVersion}: {snapshot.policy.outputFields.join(', ')}.</p>
      <p>Per-run budgets:
        {Object.entries(snapshot.policy.budgets).map(([key, value]) => `${key}=${value}`).join(', ')}.
        The native approval dialog verifies this policy against the desktop's reviewed hash.</p>
      <h3>Provision app credential</h3>
      {#if state.appProvisioningBlockedReason}<p role="status">{state.appProvisioningBlockedReason}</p>{/if}
      <p>Native export only, never shown here. Protect the file as a Docker secret, mount read-only into
        the intended app only; never bake into images, claims or editable configuration.
        Windows export is blocked until private ACLs can be verified.</p>
      <div class="fields">
        <label>App label <input bind:value={label} maxlength="100" disabled={busy} /></label>
        <label>Instance ID <input bind:value={instanceId} maxlength="128" disabled={busy} /></label>
        <button disabled={busy || !!state.appProvisioningBlockedReason || !label.trim() || !instanceId.trim()}
          onclick={() => void perform(() => window.workingMemory.exportHostTaskApp({ label, instanceId }))}>
          Export new private credential…
        </button>
      </div>
      <h3>App credentials</h3>
      {#each snapshot.apps as app}
        <p>{app.label} · <code>{app.id}</code> · instance {app.instanceId}
          · {app.revokedAt ? 'credential revoked' : 'credential provisioned'}
          <button disabled={busy || !!app.revokedAt}
            onclick={() => void perform(() => window.workingMemory.revokeHostTaskApp(app.id))}>Revoke credential…</button>
        </p>
      {:else}<p>No app credentials provisioned.</p>{/each}
      <h3>Approve an expiring grant</h3>
      <p>SID and tenant below are declarations, not proof of identity. Approval does not enable an unverified runner.</p>
      <div class="fields">
        <label>App
          <select bind:value={appId} disabled={busy}>
            <option value="">Select an app</option>
            {#each snapshot.apps as app}
              <option value={app.id} disabled={!!app.revokedAt}>{app.label} ({app.id}, instance {app.instanceId})</option>
            {/each}
          </select>
        </label>
        <label>Windows SID <input bind:value={windowsSid} placeholder="S-1-5-21-…" disabled={busy} /></label>
        <label>Microsoft tenant UUID <input bind:value={tenantId} disabled={busy} /></label>
        <label>Expiry
          <select bind:value={lifetime} disabled={busy}>
            <option value="1">One hour</option>
            <option value="8">Eight hours</option>
          </select>
        </label>
        <button disabled={busy || !appId || !windowsSid || !tenantId}
          onclick={() => void perform(() => window.workingMemory.approveHostTaskGrant({
            appId, windowsSid, tenantId, expiresAt: Date.now() + Number(lifetime) * 3_600_000,
          }))}>Review scope and approve…</button>
      </div>
      <h3>Grants</h3>
      {#each snapshot.grants as grant}
        <p><code>{grant.id}</code> · app {grant.appId} · {grant.windowsSid} · tenant {grant.tenantId} ·
          expires {new Date(grant.expiresAt).toLocaleString()} ·
          {grant.revokedAt ? 'revoked' : grant.expiresAt <= now ? 'expired' : 'approved (execution remains gated)'}
          <button disabled={busy || !!grant.revokedAt}
            onclick={() => void perform(() => window.workingMemory.revokeHostTaskGrant(grant.id))}>Revoke…</button>
        </p>
      {:else}<p>No grants.</p>{/each}
      <h3>Jobs</h3>
      {#each snapshot.jobs as job}
        <p><code>{job.id}</code> · app {job.appId} · {job.state}
          {#if job.blockedReason} · blocked: {job.blockedReason}{/if}
          {#if ['queued', 'awaiting-approval'].includes(job.state)}
            <button disabled={busy}
              onclick={() => void perform(() => window.workingMemory.denyHostTaskJob(job.id))}>Deny…</button>
          {/if}
          {#if job.state === 'needs-sign-in'}
            Microsoft sign-in must be completed through a verified native identity flow; this panel cannot sign in or bypass policy.
          {/if}
        </p>
      {:else}<p>No jobs. No host execution or ADO sign-in is performed by this panel.</p>{/each}
      <h3>Runner availability</h3>
      {#each snapshot.runners as runner}
        <p>{runner.id} · declared {runner.windowsSid} · {runner.revokedAt ? 'revoked registration' : 'registration only'}.
          Heartbeat unavailable; offline/stale status cannot be verified. Execution remains blocked.</p>
      {:else}<p>No registered runners; offline / unavailable.</p>{/each}
    {/if}
  {/if}
</dialog>

<style>
  .host-tasks { width: min(1000px, 90vw); padding: 1rem; overflow: auto; max-height: 85vh; border: 1px solid #bcb7bc; border-radius: 8px; color: #29252a; background: #faf9f7; }
  .host-tasks::backdrop { background: #0006; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
  h2, h3 { margin: 0.8rem 0; }
  p { max-width: 85ch; }
  .actions, .fields { display: flex; flex-wrap: wrap; gap: 0.7rem; align-items: end; }
  label { display: flex; flex-direction: column; gap: 0.3rem; }
  input, select { max-width: 28rem; }
  code { overflow-wrap: anywhere; }
  .policy-query { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
