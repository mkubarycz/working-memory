<script lang="ts">
  let { count }: { count: number } = $props();
</script>

{#if count > 0}
  <span class="unread-response-badge" title={`${count} unread response${count === 1 ? '' : 's'}`} aria-label={`${count} unread responses`}>{count}</span>
{/if}

<style>
  .unread-response-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    border-radius: 8px;
    background: #777981;
    color: white;
    font-size: 10px;
    font-weight: 600;
  }
</style>
