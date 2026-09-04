<script lang="ts">
/**
 * plugin-scaffold — the CANONICAL example frontend VIEW (plan 03).
 *
 * Minimal Svelte 5 runes component, compiled by the scaffold's vite lib
 * build against the SHARED svelte runtime (svelte is externalized — the
 * import map in the host's index.html resolves this build's bare
 * `svelte`/`svelte/internal/client` imports to the app's own runtime
 * instances; two runtimes would break reactivity).
 *
 * PITFALL (found by the plan-03 spike): never name a destructured prop
 * `state` — svelte 5.56's compiler then mis-compiles the `$state` rune as
 * a legacy auto-subscription of that prop.
 */
let count = $state(0);
</script>

<div class="flex flex-col gap-2 p-4">
  <h3 class="text-sm font-semibold">Plugin Scaffold (frontend view)</h3>
  <p class="text-xs opacity-70">
    A dynamically-imported frontend plugin view — registered through the
    frontend ABI into the same registry the built-in views use.
  </p>
  <button type="button" class="btn btn-xs w-fit" onclick={() => count++}>
    Clicked {count} times
  </button>
</div>
