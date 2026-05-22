const STORAGE_KEY = "dispatch-api-url";

function getDefaultApiBase(): string {
	if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
	// Derive from current page hostname so it works over Tailscale/LAN
	if (typeof window !== "undefined" && window.location.hostname !== "localhost") {
		return `http://${window.location.hostname}:3000`;
	}
	return "http://localhost:3000";
}

const DEFAULT_API_BASE = getDefaultApiBase();

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
