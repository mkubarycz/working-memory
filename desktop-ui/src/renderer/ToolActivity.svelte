<script lang="ts">
  import type { ChatRun, ChatTarget, ChatToolRow } from './chatHistory';

  let { run, onInspect, onOpen }: {
    run: ChatRun;
    onInspect: (tool: ChatToolRow) => void;
    onOpen: (target: ChatTarget) => void;
  } = $props();

  const count = $derived(Math.max(run.tools.length, run.progress?.length ?? 0));
  const failed = $derived(Math.max(run.tools.filter((tool) => tool.status === 'failure').length,
    run.progress?.filter((item) => item.status === 'failed').length ?? 0));
  const cancelled = $derived(Math.max(run.tools.filter((tool) => tool.status === 'cancelled').length,
    run.progress?.filter((item) => item.status === 'cancelled').length ?? 0));
  const pending = $derived(run.tools.filter((tool) => tool.status === 'pending').length);
</script>

<details class="tool-activity">
  <summary>
    <span aria-hidden="true" class="codicon codicon-tools"></span>
    <span>
    {count} tool {count === 1 ? 'call' : 'calls'}
    {#if failed}<span class="tool-failures"> · {failed} failed</span>{/if}
    {#if cancelled}<span> · {cancelled} cancelled</span>{/if}
    {#if pending}<span> · {pending} pending</span>{/if}
    </span>
  </summary>
  {#if run.tools.length}
    <ol class="tool-rows" aria-label="Tool activity">
      {#each run.tools as tool (`${tool.journalId}:${tool.sequence}`)}
        <li class:failed={tool.status === 'failure'} class:cancelled={tool.status === 'cancelled'}>
          <button class="tool-row-main" onclick={() => onInspect(tool)} aria-label={`Inspect ${tool.toolName}`}>
            <span aria-hidden="true" class={`codicon codicon-${tool.mode === 'write' ? 'edit' : 'book'}`}></span>
            <span>{tool.toolName}</span>
            <span class="tool-status">{tool.status}</span>
          </button>
          {#if tool.entity?.target}
            <button class="tool-entity" title={`Open ${tool.entity.label}`} onclick={() => onOpen(tool.entity!.target!)}>{tool.entity.label}</button>
          {:else if tool.entity}
            <span class="tool-entity unsupported">{tool.entity.label}</span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
  {#if run.progress?.length}
    <ul class="tool-progress" aria-label="Tool outcomes">
      {#each run.progress as item}
        <li class:failed={item.status === 'failed'}>{item.name}: {item.summary}</li>
      {/each}
    </ul>
  {/if}
</details>
