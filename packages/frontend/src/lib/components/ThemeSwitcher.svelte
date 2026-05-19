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
] as const;

const STORAGE_KEY = "dispatch-theme";

const { onclose }: { onclose: () => void } = $props();

let currentTheme = $state(
	(typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "dark",
);

function selectTheme(theme: string) {
	currentTheme = theme;
	document.documentElement.setAttribute("data-theme", theme);
	localStorage.setItem(STORAGE_KEY, theme);
	onclose();
}
</script>

<!-- Backdrop -->
<div
	class="fixed inset-0 z-40 bg-black/40"
	role="button"
	tabindex="0"
	onclick={onclose}
	onkeydown={(e) => e.key === "Escape" && onclose()}
	aria-label="Close theme switcher"
></div>

<!-- Modal -->
<div
	class="fixed top-16 right-4 z-50 bg-base-100 border border-base-300 rounded-xl shadow-xl p-4 w-56"
	role="dialog"
	aria-label="Theme switcher"
>
	<p class="text-sm font-semibold mb-3 text-base-content">Select Theme</p>
	<ul class="space-y-1">
		{#each THEMES as theme}
			<li>
				<button
					type="button"
					class="w-full text-left px-3 py-1.5 rounded-lg text-sm capitalize hover:bg-base-200 transition-colors {currentTheme ===
					theme
						? 'bg-primary text-primary-content'
						: ''}"
					onclick={() => selectTheme(theme)}
				>
					{theme}
				</button>
			</li>
		{/each}
	</ul>
</div>
