<script lang="ts">
import type { LogEntry } from "../types.js";

const { entries }: { entries: LogEntry[] } = $props();
</script>

<div class="collapse collapse-arrow bg-base-200 mt-4">
  <input type="checkbox" /> 
  <div class="collapse-title text-sm font-medium">
    Permission Log ({entries.length})
  </div>
  <div class="collapse-content text-xs max-h-40 overflow-y-auto">
    {#if entries.length === 0}
      <p class="text-base-content/50 italic">No permissions granted or denied yet.</p>
    {:else}
      {#each entries as entry (entry.id)}
        <div class="flex items-center gap-2 py-1 border-b border-base-300">
          <span class="badge badge-sm {entry.action === 'reject' ? 'badge-error' : 'badge-success'}">
            {entry.action}
          </span>
          <span class="text-base-content/70">{entry.permission}</span>
          <span class="text-base-content/50 ml-auto text-xs">{entry.timestamp}</span>
        </div>
        <p class="text-base-content/60 pl-2 pb-1">{entry.description}</p>
      {/each}
    {/if}
  </div>
</div>
