<script lang="ts" module>
  export type SettingsTab = 'models' | 'human' | 'system' | 'features' | 'access' | 'sessions' | 'diagnostics';
  export type SystemTab = 'back-end' | 'front-end' | 'container-provider';
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type {
    EditableModelProfile,
    CopilotModels,
    ModelRouting,
    PublicConfig,
  } from '../../shared/contracts';
  import { humanInitials } from '../humanIdentity';
  import InstancesView from './InstancesView.svelte';
  import UpdatesView from './UpdatesView.svelte';
  import FeaturesView from './FeaturesView.svelte';
  import AccessView from './AccessView.svelte';
  import SessionsView from './SessionsView.svelte';
  import DiagnosticsView from './DiagnosticsView.svelte';
  import type { InstanceFeatures } from '../../../../control-plane/src/instanceFeatures';

  interface Props {
    profiles: Array<EditableModelProfile & { apiKey: string }>;
    routing: ModelRouting;
    humanName: string;
    credentialStorage: PublicConfig['credentialStorage'];
    settingsStatus: string;
    settingsError?: boolean;
    profileTestStatus?: string;
    profileTestError?: boolean;
    saving: boolean;
    testingProfileId: string | null;
    onHumanName: (value: string) => void;
    onAddProfile: () => void;
    onRemoveProfile: (id: string) => void;
    onTestProfile: (profile: EditableModelProfile & { apiKey: string }) => Promise<void>;
    onChange: () => void;
    onFlush: () => void;
    tab?: SettingsTab;
    systemTab?: SystemTab;
    selectedMcpUrl: string | null;
    onMakeCurrent: (mcpUrl: string) => Promise<void>;
    onInstancesChanged: () => Promise<void>;
    onFeaturesChanged: (features: InstanceFeatures) => void;
  }

  let {
    profiles,
    routing,
    humanName,
    credentialStorage,
    settingsStatus,
    settingsError = false,
    profileTestStatus = '',
    profileTestError = false,
    saving,
    testingProfileId,
    onHumanName,
    onAddProfile,
    onRemoveProfile,
    onTestProfile,
    onChange,
    onFlush,
    tab = $bindable('models'),
    systemTab = $bindable('back-end'),
    selectedMcpUrl,
    onMakeCurrent,
    onInstancesChanged,
    onFeaturesChanged,
  }: Props = $props();

  const SPEEDS = ['slow', 'medium', 'fast'] as const;
  const DEPTHS = [
    { id: 'simple', label: 'Simple' },
    { id: 'complex', label: 'Complex' },
    { id: 'deep', label: 'Deep Thought' },
  ] as const;
  let copilot = $state<CopilotModels | null>(null);
  let loadingCopilot = $state(false);
  let copilotStatus = $state('');
  let requestedCopilotModels = false;
  onDestroy(() => onFlush());

  $effect(() => {
    if (profiles.some((profile) => profile.provider === 'copilot')) {
      untrack(() => {
        if (!requestedCopilotModels) {
          requestedCopilotModels = true;
          void loadCopilotModels();
        }
      });
    }
  });

  async function loadCopilotModels(): Promise<void> {
    loadingCopilot = true;
    copilotStatus = 'Checking local Copilot...';
    try {
      copilot = await window.workingMemory.listCopilotModels();
      copilotStatus = `Signed in. ${copilot.models.length} models available.`;
    } catch (error) {
      copilotStatus = (error instanceof Error ? error.message : String(error))
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    } finally {
      loadingCopilot = false;
    }
  }
</script>

<section class="settings">
  <header>
    <h1>Settings</h1>
  </header>
  <div class="settings-tabs" role="tablist" aria-label="Settings">
    <button role="tab" aria-selected={tab === 'models'} onclick={() => (tab = 'models')}>Models</button>
    <button role="tab" aria-selected={tab === 'human'} onclick={() => (tab = 'human')}>Human</button>
    <button role="tab" aria-selected={tab === 'system'} onclick={() => (tab = 'system')}>System</button>
    <button role="tab" aria-selected={tab === 'features'} onclick={() => (tab = 'features')}>Features</button>
    <button role="tab" aria-selected={tab === 'access'} onclick={() => (tab = 'access')}>Access</button>
    <button role="tab" aria-selected={tab === 'sessions'} onclick={() => (tab = 'sessions')}>Sessions</button>
    <button role="tab" aria-selected={tab === 'diagnostics'} onclick={() => (tab = 'diagnostics')}>Diagnostics</button>
  </div>
  {#if tab === 'models'}
    <div class="model-settings" oninput={onChange} onchange={onChange} onfocusout={onFlush}>
    <p class="settings-intro">
      Configure GitHub Copilot or OpenAI-compatible model profiles and route AI work by speed and depth.
      {credentialStorage === 'secure'
        ? ' Credentials stay in OS-backed secure storage.'
        : credentialStorage === 'local'
          ? ' Credentials are encrypted in this user profile without relying on macOS Keychain approval.'
        : credentialStorage === 'session'
          ? ' The API key is held in memory for this app session because secure storage is unavailable.'
          : ' Secure storage is unavailable; API keys can be used for the current app session but are not written to disk.'}
    </p>
    <div class="model-profile-list">
      {#each profiles as profile, index (profile.id)}
        <fieldset class="model-profile">
          <legend>{profile.name || `Model ${index + 1}`}</legend>
          <label>Name<input bind:value={profile.name} placeholder="Fast local model" /></label>
          <label>
            Provider
            <select
              bind:value={profile.provider}
              onchange={(event) => {
                profile.model = event.currentTarget.value === 'copilot' ? 'auto' : '';
                profile.apiKey = '';
              }}
            >
              <option value="openai-compatible">OpenAI-compatible / Azure Foundry</option>
              <option value="copilot">GitHub Copilot (local CLI)</option>
            </select>
          </label>
          {#if profile.provider === 'copilot'}
            <p class="copilot-help">Uses your Copilot CLI or active GitHub CLI sign-in.
              To sign in, run <code>copilot login</code> or <code>gh auth login</code> in Terminal.</p>
            <label>Model
              <select bind:value={profile.model}>
                <option value="auto">Auto (Copilot default)</option>
                {#if profile.model && profile.model !== 'auto' && !copilot?.models.some((model) => model.id === profile.model)}
                  <option value={profile.model}>{profile.model}</option>
                {/if}
                {#each copilot?.models ?? [] as model (model.id)}
                  {#if model.id !== 'auto'}
                    <option value={model.id}>{model.name}</option>
                  {/if}
                {/each}
              </select>
            </label>
            <p class="copilot-status" role="status">{copilotStatus}</p>
          {:else}
            <label>Endpoint<input bind:value={profile.endpoint} placeholder="http://localhost:11434/v1" /></label>
            <label>Model<input bind:value={profile.model} placeholder="qwen3:14b" /></label>
            <label>
              API key
              <input
                type="password"
                bind:value={profile.apiKey}
                placeholder={profile.hasApiKey ? 'Saved' : 'Optional for local endpoints'}
                autocomplete="new-password"
              />
            </label>
          {/if}
          <div class="model-profile-actions">
            {#if profile.provider === 'copilot'}
              <button class="secondary" disabled={loadingCopilot || saving || testingProfileId !== null}
                onclick={() => void loadCopilotModels()}>
                {loadingCopilot ? 'Loading models...' : copilot ? 'Refresh models' : 'Retry loading models'}
              </button>
            {/if}
            <button
              class="secondary"
              disabled={saving || testingProfileId !== null}
              onclick={() => void onTestProfile(profile)}
            >{testingProfileId === profile.id ? 'Testing...' : 'Test'}</button>
            <button
              class="remove-model"
              disabled={profiles.length <= 1 || saving || testingProfileId !== null}
              onclick={() => { onRemoveProfile(profile.id); onChange(); }}
            >Remove</button>
          </div>
        </fieldset>
      {/each}
      <button class="add-model" onclick={() => { onAddProfile(); onChange(); }}>
        <span aria-hidden="true" class="codicon codicon-add"></span>
        Add model profile
      </button>
    </div>
    <h2>Routing matrix</h2>
    <div class="routing-matrix">
      <div class="routing-corner">Depth / speed</div>
      {#each SPEEDS as speed}
        <div class="routing-column">{speed}</div>
      {/each}
      {#each DEPTHS as depth}
        <div class="routing-row">{depth.label}</div>
        {#each SPEEDS as speed}
          <label>
            <span class="sr-only">{depth.label} / {speed}</span>
            <select bind:value={routing[`${depth.id}:${speed}`]}>
              {#each profiles as profile (profile.id)}
                <option value={profile.id}>{profile.name || profile.model}</option>
              {/each}
            </select>
          </label>
        {/each}
      {/each}
    </div>
    </div>
    {#if profileTestStatus}<p role={profileTestError ? 'alert' : 'status'}>{profileTestStatus}</p>{/if}
  {:else if tab === 'features'}
    {#key selectedMcpUrl}<FeaturesView onChanged={onFeaturesChanged} />{/key}
  {:else if tab === 'access'}
    {#key selectedMcpUrl}<AccessView />{/key}
  {:else if tab === 'sessions'}
    {#key selectedMcpUrl}<SessionsView mcpUrl={selectedMcpUrl} />{/key}
  {:else if tab === 'diagnostics'}
    {#key selectedMcpUrl}<DiagnosticsView />{/key}
  {:else if tab === 'system'}
    <div class="settings-tabs settings-subtabs" role="tablist" aria-label="System">
      <button id="system-front-end-tab" role="tab" aria-selected={systemTab === 'front-end'}
        aria-controls="system-front-end" onclick={() => (systemTab = 'front-end')}>Front End</button>
      <button id="system-back-end-tab" role="tab" aria-selected={systemTab === 'back-end'}
        aria-controls="system-back-end" onclick={() => (systemTab = 'back-end')}>Backend</button>
      <button id="system-container-provider-tab" role="tab" aria-selected={systemTab === 'container-provider'}
        aria-controls="system-container-provider" onclick={() => (systemTab = 'container-provider')}>Container Provider</button>
    </div>
    {#if systemTab === 'back-end'}
      <div id="system-back-end" role="tabpanel" aria-labelledby="system-back-end-tab">
        <InstancesView section="backend" {selectedMcpUrl} {onMakeCurrent} {onInstancesChanged} />
      </div>
    {:else if systemTab === 'front-end'}
      <div id="system-front-end" role="tabpanel" aria-labelledby="system-front-end-tab">
        <UpdatesView />
      </div>
    {:else}
      <div id="system-container-provider" role="tabpanel" aria-labelledby="system-container-provider-tab">
        <InstancesView section="provider" {selectedMcpUrl} {onMakeCurrent} {onInstancesChanged} />
      </div>
    {/if}
  {:else}
    <div class="human-settings">
      <label>
        Human name
        <input
          value={humanName}
          oninput={(event) => { onHumanName(event.currentTarget.value); onChange(); }}
          onblur={onFlush}
          placeholder="Flesh Bag"
        />
      </label>
      <span class="human-initials-preview">{humanInitials(humanName)}</span>
      <p>Your initials appear beside your messages in the inline chat response.</p>
    </div>
  {/if}
  {#if tab !== 'system' && tab !== 'features' && tab !== 'access' && tab !== 'sessions' && tab !== 'diagnostics'}
    <p class="settings-actions" role={settingsError ? 'alert' : 'status'}>{settingsStatus || 'Changes save automatically.'}</p>
  {/if}
</section>
