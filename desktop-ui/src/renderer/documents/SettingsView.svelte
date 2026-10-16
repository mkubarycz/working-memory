<script lang="ts">
  import type {
    EditableModelProfile,
    CopilotModels,
    ModelRouting,
    PublicConfig,
  } from '../../shared/contracts';
  import { humanInitials } from '../humanIdentity';

  interface Props {
    profiles: Array<EditableModelProfile & { apiKey: string }>;
    routing: ModelRouting;
    humanName: string;
    credentialStorage: PublicConfig['credentialStorage'];
    settingsStatus: string;
    saving: boolean;
    testingProfileId: string | null;
    onHumanName: (value: string) => void;
    onAddProfile: () => void;
    onRemoveProfile: (id: string) => void;
    onTestProfile: (profile: EditableModelProfile & { apiKey: string }) => Promise<void>;
    onSave: () => Promise<void>;
  }

  let {
    profiles,
    routing,
    humanName,
    credentialStorage,
    settingsStatus,
    saving,
    testingProfileId,
    onHumanName,
    onAddProfile,
    onRemoveProfile,
    onTestProfile,
    onSave,
  }: Props = $props();

  const SPEEDS = ['slow', 'medium', 'fast'] as const;
  const DEPTHS = [
    { id: 'simple', label: 'Simple' },
    { id: 'complex', label: 'Complex' },
    { id: 'deep', label: 'Deep Thought' },
  ] as const;
  let tab = $state<'models' | 'routing' | 'human'>('models');
  let copilot = $state<CopilotModels | null>(null);
  let loadingCopilot = $state(false);
  let copilotStatus = $state('');

  async function loadCopilotModels(): Promise<void> {
    loadingCopilot = true;
    copilotStatus = 'Checking local Copilot...';
    try {
      copilot = await window.workingMemory.listCopilotModels();
      copilotStatus = `Signed in as ${copilot.account}. ${copilot.models.length} models available.`;
    } catch (error) {
      copilot = null;
      copilotStatus = error instanceof Error ? error.message : String(error);
    } finally {
      loadingCopilot = false;
    }
  }
</script>

<section class="settings">
  <header>
    <p class="eyebrow">Configuration</p>
    <h1>AI models</h1>
    <p>
      Configure GitHub Copilot or OpenAI-compatible model profiles and route AI work by speed and depth.
      {credentialStorage === 'secure'
        ? ' Credentials stay in OS-backed secure storage.'
        : credentialStorage === 'local'
          ? ' Credentials are encrypted in this user profile without relying on macOS Keychain approval.'
        : credentialStorage === 'session'
          ? ' The API key is held in memory for this app session because secure storage is unavailable.'
          : ' Secure storage is unavailable; API keys can be used for the current app session but are not written to disk.'}
    </p>
  </header>
  <div class="settings-tabs" role="tablist" aria-label="AI settings">
    <button role="tab" aria-selected={tab === 'models'} onclick={() => (tab = 'models')}>Models</button>
    <button role="tab" aria-selected={tab === 'routing'} onclick={() => (tab = 'routing')}>Routing matrix</button>
    <button role="tab" aria-selected={tab === 'human'} onclick={() => (tab = 'human')}>Human</button>
  </div>
  {#if tab === 'models'}
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
            <p>Uses the local Copilot CLI and its GitHub sign-in, not an Azure API key.
              Sign in from Terminal with <code>copilot login</code> if needed.
              Copilot plan allowances and organization policies apply. No automatic Azure fallback.</p>
            <label>Model
              <input bind:value={profile.model} list="copilot-models" placeholder="auto" />
            </label>
            <button class="secondary" disabled={loadingCopilot || saving || testingProfileId !== null} onclick={() => void loadCopilotModels()}>
              {loadingCopilot ? 'Loading models...' : 'Load Copilot models'}
            </button>
            <p role="status">{copilotStatus}</p>
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
            <button
              class="secondary"
              disabled={saving || testingProfileId !== null}
              onclick={() => void onTestProfile(profile)}
            >{testingProfileId === profile.id ? 'Testing...' : 'Test'}</button>
            <button
              class="remove-model"
              disabled={profiles.length <= 1 || saving || testingProfileId !== null}
              onclick={() => onRemoveProfile(profile.id)}
            >Remove</button>
          </div>
        </fieldset>
      {/each}
      <button class="add-model" onclick={onAddProfile}>
        <span aria-hidden="true" class="codicon codicon-add"></span>
        Add model profile
      </button>
      <datalist id="copilot-models">
        {#each copilot?.models ?? [] as model (model.id)}
          <option value={model.id}>{model.name}</option>
        {/each}
      </datalist>
    </div>
  {:else if tab === 'routing'}
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
  {:else}
    <div class="human-settings">
      <label>
        Human name
        <input
          value={humanName}
          oninput={(event) => onHumanName((event.currentTarget as HTMLInputElement).value)}
          placeholder="Flesh Bag"
        />
      </label>
      <span class="human-initials-preview">{humanInitials(humanName)}</span>
      <p>Your initials appear beside your messages in the inline chat response.</p>
    </div>
  {/if}
  <div class="settings-actions">
    <button class="primary" disabled={saving || testingProfileId !== null} onclick={() => void onSave()}>
      {saving ? 'Saving...' : 'Save'}
    </button>
    <span>{settingsStatus}</span>
  </div>
</section>
