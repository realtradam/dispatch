const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const config = {
	apiBase: API_BASE,
	wsUrl: `${API_BASE.replace(/^http/, "ws")}/ws`,
} as const;
