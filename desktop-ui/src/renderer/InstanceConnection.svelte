<script lang="ts">
  import type { InstanceConnectionState } from '../shared/instanceIdentity';
  import type { DesktopEnvironment } from '../shared/contracts';
  let { connection, error = '', environments, selectedMcpUrl, onSwitch, onConnected, onRetry, onManage }: {
    connection: InstanceConnectionState | null; error?: string;
    environments: DesktopEnvironment[]; selectedMcpUrl: string | null;
    onSwitch: (url: string) => Promise<void>; onConnected: () => Promise<void>;
    onRetry: () => Promise<void>; onManage: () => void;
  } = $props();
  let password = $state('');
  let repeatedPassword = $state('');
  let passwordHint = $state('');
  let busy = $state(false);
  let signInError = $state('');
  const setup = $derived(connection?.passwordConfigured === false);
  async function connect(): Promise<void> {
    if (setup && password !== repeatedPassword) { signInError = 'The passwords do not match.'; return; }
    busy = true;
    signInError = '';
    const value = password;
    password = '';
    repeatedPassword = '';
    try {
      await window.workingMemory.signInInstance({ password: value, setup, ...(setup ? { passwordHint } : {}) });
      await onConnected();
    } catch (cause) { signInError = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
</script>

<main class="instance-connection" aria-label="Connect to Working Memory">
  <section>
    <h1>{setup ? 'Set up your Working Memory password' : 'Connect to Working Memory'}</h1>
    <p>Sign in once to access this instance's data and settings. Agent access requires your separate approval.</p>
    {#if environments.length}
      <label>Instance
        <select value={selectedMcpUrl ?? ''} disabled={busy} onchange={(event) => void onSwitch(event.currentTarget.value)}>
          {#each environments as environment}
            <option value={environment.mcpUrl}>{environment.displayName} ({environment.port})</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if connection}
      <p class="instance-address">{connection.environment}</p>
      {#if setup}
        <p>No owner password has been set. Choose a password of at least 12 characters to secure this instance.</p>
        {#if !connection.setupAvailable}
          <p role="alert">Initial setup requires the local instance owner. For a self-hosted instance, ask its administrator to provision owner setup. For a managed instance, use Manage instances to upgrade it, then retry.</p>
        {/if}
      {:else}
        <p id="connection-password-hint">Password hint: {connection.passwordHint || 'No hint has been set.'}</p>
      {/if}
      <form onsubmit={(event) => { event.preventDefault(); void connect(); }}>
        <label>Instance password
          <input type="password" bind:value={password} autocomplete={setup ? 'new-password' : 'current-password'}
            minlength={setup ? 12 : 1} maxlength="1024" required
            aria-describedby={setup ? undefined : 'connection-password-hint'} />
        </label>
        {#if setup}
          <label>Confirm password<input type="password" bind:value={repeatedPassword} autocomplete="new-password" maxlength="1024" required /></label>
          <label>Password hint (optional)<textarea bind:value={passwordHint} rows="2" maxlength="1000"></textarea></label>
          <p class="hint">The hint is visible before sign-in. Do not include your password or other secrets.</p>
        {/if}
        <button disabled={busy || !password || (setup && (!connection.setupAvailable || password.length < 12))}>
          {busy ? 'Connecting...' : setup ? 'Set password and connect' : 'Sign in'}
        </button>
      </form>
      <p class="hint">Your password is not saved. The private session stays in the desktop process until sign-out, expiry, or app restart. OS credential storage is not required.</p>
    {:else if !error}
      <p role="status">{selectedMcpUrl ? 'Checking instance connection...' : 'No instance is selected. Start or create one using Manage instances.'}</p>
    {/if}
    {#if error || signInError}<p role="alert">{signInError || error}</p>{/if}
    <div class="actions">
      <button disabled={busy} onclick={() => void onRetry()}>Retry connection</button>
      <button disabled={busy} onclick={onManage}>Manage instances</button>
    </div>
  </section>
</main>

<style>
  .instance-connection { height: 100vh; overflow: auto; display: grid; place-items: center; padding: 32px; box-sizing: border-box; }
  section { max-width: 560px; width: 100%; display: grid; gap: 12px; }
  h1, p { margin: 0; }
  form, label { display: grid; gap: 8px; }
  form { gap: 16px; }
  .actions { display: flex; gap: 8px; }
  .hint, .instance-address { color: var(--desktop-chat-muted); font-size: 12px; overflow-wrap: anywhere; }
  [role="alert"] { color: var(--vscode-errorForeground, #f48771); }
</style>
