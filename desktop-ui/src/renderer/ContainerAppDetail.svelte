<script lang="ts">
  import { onMount } from 'svelte';
  import type { AppMcpStatus, AppMcpTool, AppResourceContract, ContainerAppStatus } from '../shared/contracts';
  import { effectiveContainerAppMcp, type ContainerAppItem } from './containerApps';

  interface Props {
    app: ContainerAppItem;
    status?: ContainerAppStatus;
    busy: boolean;
    onAction: (action: 'run' | 'open' | 'stop' | 'refresh') => void;
  }

  let { app, status, busy, onAction }: Props = $props();
  let mcpStatus = $state<AppMcpStatus | null>(null);
  let tools = $state<AppMcpTool[]>([]);
  let selectedTool = $state('');
  let argumentsText = $state('{}');
  let toolResult = $state('');
  let mcpBusy = $state(false);
  let mcpError = $state('');
  let contract = $state<AppResourceContract | null>(null);
  let contractBusy = $state(false);
  const mcpEndpoint = $derived(effectiveContainerAppMcp(app, status));
  const contractResourceCount = $derived(contract
    ? Array.isArray(contract.resources)
      ? contract.resources.length
      : Object.keys(contract.resources).length
    : 0);
  const fields = $derived(status ? [
    ['Display', status.displayName],
    ['Claim title', status.claimTitle],
    ['Claim', status.claimSlug],
    ['Repository', status.repository],
    ['Build context', status.buildContext],
    ['Dockerfile', status.dockerfile],
    ['Image', status.image],
    ['Container', status.containerName],
    ['Docker context', status.dockerContext ?? 'Unavailable'],
    ['State / health', status.state],
    ['Ports', `${status.hostPort} → ${status.containerPort}`],
    ['URL', status.url],
    ...(status.mcp ? [['MCP endpoint', status.mcp.url]] : []),
    ...(status.application ? [
      ['Application ID', status.application.id],
      ['Contract version', status.application.contractVersion],
      ['Contract discovery', status.application.discovery.toolName],
      ...(status.application.discovery.url ? [['Contract URL', status.application.discovery.url]] : []),
      ['Capabilities', status.application.capabilities.join(', ') || 'None advertised'],
      ['Data ownership', status.application.dataOwnership],
      ...(status.application.healthUrl ? [['Health endpoint', status.application.healthUrl]] : []),
      ...(status.application.httpUrl ? [['HTTP endpoint', status.application.httpUrl]] : []),
      ...(status.application.uiUrl ? [['UI endpoint', status.application.uiUrl]] : []),
    ] : []),
    ['Last action', status.lastAction],
  ] : []);

  async function refreshMcpStatus(): Promise<void> {
    mcpStatus = await window.workingMemory.getAppMcpStatus(app.id);
  }

  async function refreshContract(): Promise<void> {
    contractBusy = true;
    mcpError = '';
    try {
      contract = await window.workingMemory.getAppResourceContract(app.id);
    } catch (error) {
      contract = null;
      mcpError = error instanceof Error ? error.message : String(error);
    } finally {
      contractBusy = false;
    }
  }

  async function connectMcp(): Promise<void> {
    mcpBusy = true;
    mcpError = '';
    try {
      mcpStatus = await window.workingMemory.connectAppMcp(app.id);
      await refreshTools();
      if (status?.application) await refreshContract();
    } catch (error) {
      mcpError = error instanceof Error ? error.message : String(error);
      await refreshMcpStatus();
    } finally {
      mcpBusy = false;
    }
  }

  async function disconnectMcp(): Promise<void> {
    mcpBusy = true;
    try {
      mcpStatus = await window.workingMemory.disconnectAppMcp(app.id);
      tools = [];
      selectedTool = '';
    } catch (error) {
      mcpError = error instanceof Error ? error.message : String(error);
    } finally {
      mcpBusy = false;
    }
  }

  async function refreshTools(): Promise<void> {
    mcpBusy = true;
    mcpError = '';
    try {
      tools = await window.workingMemory.listAppMcpTools(app.id);
      if (!tools.some((tool) => tool.name === selectedTool)) selectedTool = tools[0]?.name ?? '';
    } catch (error) {
      mcpError = error instanceof Error ? error.message : String(error);
    } finally {
      mcpBusy = false;
    }
  }

  async function invokeTool(): Promise<void> {
    let args: unknown;
    try {
      args = JSON.parse(argumentsText);
    } catch {
      mcpError = 'Tool arguments must be valid JSON.';
      return;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      mcpError = 'Tool arguments must be a JSON object.';
      return;
    }
    mcpBusy = true;
    mcpError = '';
    try {
      const result = await window.workingMemory.callAppMcpTool(
        app.id,
        selectedTool,
        args as Record<string, unknown>,
      );
      toolResult = JSON.stringify(result, null, 2);
    } catch (error) {
      mcpError = error instanceof Error ? error.message : String(error);
    } finally {
      mcpBusy = false;
    }
  }

  onMount(() => void refreshMcpStatus().then(async () => {
    if (mcpStatus?.state === 'connected' && status?.application) await refreshContract();
  }).catch((error) => {
    mcpError = error instanceof Error ? error.message : String(error);
  }));
</script>

<section class="container-app-detail" aria-label={`${app.displayName} details`}>
  <header>
    <div>
      <p class="eyebrow">Container app</p>
      <h1>{app.displayName}</h1>
    </div>
    <span class="detail-state state-{status?.state ?? 'unknown'}">{busy ? 'Working…' : status?.state ?? 'Loading…'}</span>
  </header>
  <div class="container-app-detail-actions">
    <button class="primary" disabled={busy} onclick={() => onAction('run')}>Run</button>
    <button class="secondary" disabled={busy} onclick={() => onAction('open')}>Open App</button>
    <button class="secondary" disabled={busy} onclick={() => onAction('stop')}>Stop</button>
    <button class="secondary" disabled={busy} onclick={() => onAction('refresh')}>Refresh Status</button>
  </div>
  {#if status?.application}
    <section class="app-contract" aria-label={`${app.displayName} resource contract`}>
      <div class="container-app-detail-actions">
        <h3>Live resource contract</h3>
        <button class="secondary" disabled={contractBusy || mcpStatus?.state !== 'connected'} onclick={refreshContract}>
          {contractBusy ? 'Fetching…' : 'Fetch Contract'}
        </button>
      </div>
      {#if contract}
        <p>
          <strong>{contract.application.name ?? contract.application.title ?? contract.application.id}</strong>
          · {contractResourceCount} resource kind{contractResourceCount === 1 ? '' : 's'}
          · contract {contract.contractVersion}
        </p>
        <pre aria-label="Live Zod-derived resource contract">{JSON.stringify(contract, null, 2)}</pre>
      {:else if mcpStatus?.state !== 'connected'}
        <p>Connect to the app MCP endpoint to fetch its live contract and business rules.</p>
      {/if}
    </section>
  {/if}
  {#if status}
    <dl>
      {#each fields as field}
        <div><dt>{field[0]}</dt><dd>{field[1]}</dd></div>
      {/each}
    </dl>
    {#if status.error}<p class="container-app-error" role="alert">{status.error}</p>{/if}
  {:else}
    <p>Refreshing live container status…</p>
  {/if}
  {#if mcpEndpoint}
    <section class="app-mcp" aria-label={`${app.displayName} MCP tools`}>
      <h2>App MCP</h2>
      <p><code>{mcpEndpoint.url}</code></p>
      <p>Status: <strong>{mcpStatus?.state ?? 'loading'}</strong></p>
      <div class="container-app-detail-actions">
        {#if mcpStatus?.state === 'connected'}
          <button class="secondary" disabled={mcpBusy} onclick={disconnectMcp}>Disconnect</button>
          <button class="secondary" disabled={mcpBusy} onclick={refreshTools}>Refresh Tools</button>
        {:else}
          <button class="primary" disabled={mcpBusy || !status?.ready} onclick={connectMcp}>Connect</button>
        {/if}
      </div>
      {#if !status?.ready}<p>Run the app and wait for healthy status before connecting.</p>{/if}
      {#if tools.length}
        <label>
          Tool
          <select bind:value={selectedTool}>
            {#each tools as tool}<option value={tool.name}>{tool.name}</option>{/each}
          </select>
        </label>
        {#if selectedTool}
          <p>{tools.find((tool) => tool.name === selectedTool)?.description ?? ''}</p>
          <label>
            JSON arguments
            <textarea rows="6" bind:value={argumentsText} spellcheck="false"></textarea>
          </label>
          <button class="primary" disabled={mcpBusy} onclick={invokeTool}>Invoke Tool</button>
        {/if}
      {/if}
      {#if mcpError}<p class="container-app-error" role="alert">{mcpError}</p>{/if}
      {#if toolResult}<pre aria-label="Tool result">{toolResult}</pre>{/if}
    </section>
  {/if}
</section>
