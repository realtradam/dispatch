import { config } from "./config.js";
import type { AgentEvent, ConnectionStatus } from "./types.js";

type EventCallback = (event: AgentEvent) => void;

// Close any stale WebSocket from HMR reloads
if (import.meta.hot) {
	import.meta.hot.dispose((data: Record<string, unknown>) => {
		const old = data._ws as WebSocket | undefined;
		if (old && old.readyState === WebSocket.OPEN) {
			old.close();
		}
	});
}

function createWebSocketClient(url: string) {
	let connectionStatus: ConnectionStatus = $state("disconnected");
	let ws: WebSocket | null = null;
	let reconnectDelay = 1000;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let manualDisconnect = false;
	const callbacks = new Set<EventCallback>();

	function connect() {
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			return;
		}
		manualDisconnect = false;
		connectionStatus = "connecting";
		ws = new WebSocket(url);

		// Store ref for HMR cleanup
		if (import.meta.hot) {
			import.meta.hot.data._ws = ws;
		}

		ws.onopen = () => {
			connectionStatus = "connected";
			reconnectDelay = 1000;
		};

		ws.onmessage = (event: MessageEvent) => {
			let data: AgentEvent;
			try {
				data = JSON.parse(event.data as string) as AgentEvent;
			} catch (err) {
				// Genuinely malformed WS payload — these are rare and harmless.
				console.warn("[ws] ignored malformed message:", err);
				return;
			}
			// Run callbacks OUTSIDE the parse try so callback throws are visible.
			// The previous catch-everything wrapper silently swallowed bugs in
			// downstream handlers (notably the `structuredClone` of a Svelte 5
			// $state proxy throwing DataCloneError), making them undiagnosable.
			for (const cb of callbacks) {
				try {
					cb(data);
				} catch (err) {
					console.error("[ws] callback threw for event:", data, err);
				}
			}
		};

		ws.onclose = () => {
			connectionStatus = "disconnected";
			ws = null;
			if (!manualDisconnect) {
				scheduleReconnect();
			}
		};

		ws.onerror = () => {
			ws?.close();
		};
	}

	function scheduleReconnect() {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 10000);
	}

	function disconnect() {
		manualDisconnect = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		ws?.close();
		ws = null;
		connectionStatus = "disconnected";
	}

	function onEvent(callback: EventCallback) {
		callbacks.add(callback);
		return () => {
			callbacks.delete(callback);
		};
	}

	/** Remove all registered event callbacks (used for HMR safety). */
	function clearCallbacks() {
		callbacks.clear();
	}

	function send(data: unknown): void {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(data));
		}
	}

	return {
		get connectionStatus() {
			return connectionStatus;
		},
		connect,
		disconnect,
		onEvent,
		clearCallbacks,
		send,
	};
}

export const wsClient = createWebSocketClient(config.wsUrl);
