/** Shared reactive app settings. */

let autoExpandThinking = $state(false);
let systemPrompt = $state("");
let savedSystemPrompt = $state("");
let toolPerms = $state<Record<string, boolean>>({
	read: true,
	edit: false,
	bash: false,
	summon: false,
	external_directory: false,
	web_search: false,
	youtube_transcribe: false,
});
let savedToolPerms = $state<Record<string, boolean>>({
	read: true,
	edit: false,
	bash: false,
	summon: false,
	external_directory: false,
	web_search: false,
	youtube_transcribe: false,
});
let skillChecks = $state<Record<string, boolean>>({});
let chunkLimit = $state(100);

export const appSettings = {
	get chunkLimit() {
		return chunkLimit;
	},
	set chunkLimit(v: number) {
		chunkLimit = v;
	},
	get autoExpandThinking() {
		return autoExpandThinking;
	},
	set autoExpandThinking(v: boolean) {
		autoExpandThinking = v;
	},
	get systemPrompt() {
		return systemPrompt;
	},
	set systemPrompt(v: string) {
		systemPrompt = v;
	},
	get savedSystemPrompt() {
		return savedSystemPrompt;
	},
	set savedSystemPrompt(v: string) {
		savedSystemPrompt = v;
	},
	get toolPerms() {
		return toolPerms;
	},
	set toolPerms(v: Record<string, boolean>) {
		toolPerms = v;
	},
	get savedToolPerms() {
		return savedToolPerms;
	},
	set savedToolPerms(v: Record<string, boolean>) {
		savedToolPerms = v;
	},
	get toolPermsDirty() {
		return Object.keys(toolPerms).some((k) => toolPerms[k] !== savedToolPerms[k]);
	},
	get skillChecks() {
		return skillChecks;
	},
	set skillChecks(v: Record<string, boolean>) {
		skillChecks = v;
	},
	get skillChecksDirty() {
		return Object.values(skillChecks).some((v) => v);
	},
};
