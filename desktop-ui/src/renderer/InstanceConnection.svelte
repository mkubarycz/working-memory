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
  let rememberPassword = $state(false);
  const setup = $derived(connection?.passwordConfigured === false);
  $effect(() => {
    selectedMcpUrl;
    password = '';
    repeatedPassword = '';
    passwordHint = '';
    rememberPassword = false;
    signInError = '';
  });
  $effect(() => { if (!connection?.rememberPasswordAvailable) rememberPassword = false; });
  async function connect(): Promise<void> {
    if (setup && password !== repeatedPassword) { signInError = 'The passwords do not match.'; return; }
    busy = true;
    signInError = '';
    const value = password;
    password = '';
    repeatedPassword = '';
    try {
      await window.workingMemory.signInInstance({ password: value, setup, rememberPassword,
        ...(setup ? { passwordHint } : {}) });
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
        <label class="remember">
          <input type="checkbox" bind:checked={rememberPassword} disabled={busy || !connection.rememberPasswordAvailable} />
          Remember on this device
        </label>
        <p class="hint">{connection.rememberPasswordAvailable
          ? 'Save in native secure storage. Your OS may ask permission.'
          : 'Native secure storage is unavailable. You can still sign in; your password will not be saved.'}</p>
        {#if connection.rememberPasswordAvailable}
          <p class="hint">{connection.rememberPasswordShared
            ? 'Installed and development builds share remembered sign-in for your OS account. Their UI settings and windows remain separate.'
            : 'Remembered sign-in is saved for this UI profile. Other UI profiles need their own sign-in.'}</p>
        {/if}
        {#if connection.rememberPasswordError}<p role="alert">{connection.rememberPasswordError}</p>{/if}
        <button disabled={busy || !password || (setup && (!connection.setupAvailable || password.length < 12))}>
          {busy ? 'Connecting...' : setup ? 'Set password and connect' : 'Sign in'}
        </button>
      </form>
      <p class="hint">Without Remember on this device, your password is not saved and restarting the app requires sign-in. Private sessions stay in the desktop process and expire after 12 hours.</p>
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
  .remember { display: flex; align-items: center; gap: 8px; }
  .actions { display: flex; gap: 8px; }
  .hint, .instance-address { color: var(--desktop-chat-muted); font-size: 12px; overflow-wrap: anywhere; }
  [role="alert"] { color: var(--vscode-errorForeground, #f48771); }
</style>
