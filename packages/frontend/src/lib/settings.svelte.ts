/** Shared reactive app settings. */

let autoExpandThinking = $state(false);

export const appSettings = {
	get autoExpandThinking() { return autoExpandThinking; },
	set autoExpandThinking(v: boolean) { autoExpandThinking = v; },
};
