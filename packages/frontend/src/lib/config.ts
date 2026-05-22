const STORAGE_KEY = "dispatch-api-url";
const DEFAULT_API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

function loadApiBase(): string {
	if (typeof localStorage !== "undefined") {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) return saved;
	}
	return DEFAULT_API_BASE;
}

let _apiBase = loadApiBase();

export const config = {
	get apiBase() {
		return _apiBase;
	},
	get wsUrl() {
		return `${_apiBase.replace(/^http/, "ws")}/ws`;
	},
	get defaultApiBase() {
		return DEFAULT_API_BASE;
	},
	setApiBase(url: string) {
		_apiBase = url;
		if (typeof localStorage !== "undefined") {
			if (url === DEFAULT_API_BASE) {
				localStorage.removeItem(STORAGE_KEY);
			} else {
				localStorage.setItem(STORAGE_KEY, url);
			}
		}
	},
};
