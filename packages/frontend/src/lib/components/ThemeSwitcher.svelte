<script lang="ts">
const THEMES = [
	"light",
	"dark",
	"dracula",
	"night",
	"nord",
	"sunset",
	"cyberpunk",
	"forest",
	"cmyk",
	"coffee",
	"caramellatte",
	"garden",
	"luxury",
] as const;

const STORAGE_KEY = "dispatch-theme";

const { onclose }: { onclose: () => void } = $props();

let currentTheme = $state(
	(typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "dark",
);

let dialogEl: HTMLDialogElement | undefined = $state();

$effect(() => {
	if (dialogEl && !dialogEl.open) dialogEl.showModal();
});

function selectTheme(theme: string) {
	currentTheme = theme;
	document.documentElement.setAttribute("data-theme", theme);
	localStorage.setItem(STORAGE_KEY, theme);
	onclose();
}
</script>

<dialog class="modal" bind:this={dialogEl} oncancel={onclose}>
	<div class="modal-box w-56">
		<h3 class="text-sm font-semibold mb-3">Select Theme</h3>
		<ul class="menu menu-sm">
			{#each THEMES as theme}
				<li>
					<button
						type="button"
						class="capitalize {currentTheme === theme ? 'menu-active' : ''}"
						onclick={() => selectTheme(theme)}
					>
						{theme}
					</button>
				</li>
			{/each}
		</ul>
	</div>
	<form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
