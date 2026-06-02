import type { PermissionReply } from "@dispatch/core";
import { createBunWebSocket } from "hono/bun";
import { agentManager, app, permissionManager } from "./app.js";

const { upgradeWebSocket, websocket } = createBunWebSocket();

let clientIdCounter = 0;

app.get(
	"/ws",
	upgradeWebSocket((_c) => {
		const clientId = String(++clientIdCounter);

		return {
			onOpen(_event, ws) {
				// Send current statuses immediately
				ws.send(JSON.stringify({ type: "statuses", statuses: agentManager.getAllStatuses() }));

				// Send any pending permission prompts
				const pending = permissionManager.getPending();
				if (pending.length > 0) {
					ws.send(JSON.stringify({ type: "permission-prompt", pending }));
				}

				const unsubscribe = agentManager.onEvent((event) => {
					ws.send(JSON.stringify(event));
				});

				permissionManager.registerClient(clientId, (data) => {
					ws.send(JSON.stringify(data));
				});

				// Store cleanup on the raw socket
				(ws as unknown as { _unsub?: () => void; _clientId?: string })._unsub = unsubscribe;
				(ws as unknown as { _unsub?: () => void; _clientId?: string })._clientId = clientId;
			},
			onMessage(event, _ws) {
				try {
					const message = JSON.parse(String(event.data)) as {
						type?: string;
						id?: string;
						reply?: string;
					};
					if (
						message.type === "permission-reply" &&
						typeof message.id === "string" &&
						typeof message.reply === "string"
					) {
						const validReplies: PermissionReply[] = ["once", "always", "reject"];
						if (validReplies.includes(message.reply as PermissionReply)) {
							permissionManager.reply(message.id, message.reply as PermissionReply);
						}
					}
				} catch {
					// ignore malformed messages
				}
			},
			onClose(_event, ws) {
				const raw = ws as unknown as { _unsub?: () => void; _clientId?: string };
				if (raw._unsub) {
					raw._unsub();
				}
				if (raw._clientId) {
					permissionManager.unregisterClient(raw._clientId);
				}
			},
		};
	}),
);

export { app };

// Starting port (overridable via PORT). When the port is already in use we
// bump up one at a time (3000 → 3001 → 3002, …) until we find a free one, so
// multiple dispatch instances (e.g. testing several features at once) can
// coexist without manually juggling ports. The frontend defaults to :3000 —
// point it at the chosen port via the in-app API-URL field / VITE_API_URL
// when a bump happens.
const START_PORT = Number(process.env.PORT) || 3000;

/**
 * Bind the server to `START_PORT`, incrementing by one on EADDRINUSE until a
 * free port is found (up to the maximum valid TCP port, 65535). Bun's
 * `Bun.serve` throws synchronously when the port is taken, so we can catch and
 * retry. Returns the live server (whose `.port` reflects the port actually
 * bound).
 */
function serveWithPortFallback() {
	let lastError: unknown;
	for (let port = START_PORT; port <= 65535; port++) {
		try {
			const server = Bun.serve({
				port,
				idleTimeout: 60,
				fetch: app.fetch,
				websocket,
			});
			if (port !== START_PORT) {
				console.warn(
					`dispatch: port ${START_PORT} in use — bound to ${port} instead. ` +
						`Set the frontend's API URL to http://localhost:${port}.`,
				);
			}
			console.log(`dispatch: API listening on http://localhost:${server.port}`);
			return server;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "EADDRINUSE") {
				lastError = err;
				continue;
			}
			throw err;
		}
	}
	console.error(
		`dispatch: no free port at or above ${START_PORT}. ` +
			`Free one up or set PORT to an open port.`,
	);
	throw lastError ?? new Error(`No free port at or above ${START_PORT}`);
}

// Only start the server when run as the entry point — importing this module
// (e.g. for `app`) must not bind a port. This preserves the prior
// default-export behavior where Bun served only the entry file.
if (import.meta.main) {
	serveWithPortFallback();
}
