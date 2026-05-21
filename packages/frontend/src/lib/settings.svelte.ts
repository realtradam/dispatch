/** Shared reactive app settings. */

let autoExpandThinking = $state(false);
let systemPrompt = $state("");
let savedSystemPrompt = $state("");
let toolPerms = $state<Record<string, boolean>>({ read: true, edit: false, bash: false, external_directory: false });
let savedToolPerms = $state<Record<string, boolean>>({ read: true, edit: false, bash: false, external_directory: false });

export const appSettings = {
	get autoExpandThinking() { return autoExpandThinking; },
	set autoExpandThinking(v: boolean) { autoExpandThinking = v; },
	get systemPrompt() { return systemPrompt; },
	set systemPrompt(v: string) { systemPrompt = v; },
	get savedSystemPrompt() { return savedSystemPrompt; },
	set savedSystemPrompt(v: string) { savedSystemPrompt = v; },
	get toolPerms() { return toolPerms; },
	set toolPerms(v: Record<string, boolean>) { toolPerms = v; },
	get savedToolPerms() { return savedToolPerms; },
	set savedToolPerms(v: Record<string, boolean>) { savedToolPerms = v; },
	get toolPermsDirty() {
		return Object.keys(toolPerms).some((k) => toolPerms[k] !== savedToolPerms[k]);
	},
};
