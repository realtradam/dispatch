import { createBunWebSocket } from "hono/bun";
import { agentManager, app, permissionManager } from "./app.js";
import type { PermissionReply } from "@dispatch/core";

const { upgradeWebSocket, websocket } = createBunWebSocket();

let clientIdCounter = 0;

app.get(
	"/ws",
	upgradeWebSocket((_c) => {
		const clientId = String(++clientIdCounter);

		return {
			onOpen(_event, ws) {
				// Send current status immediately
				ws.send(JSON.stringify({ type: "status", status: agentManager.getStatus() }));

				// Send current task list state
				const tasks = agentManager.getTaskList().getTasks();
				ws.send(JSON.stringify({ type: "task-list-update", tasks }));

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
					if (message.type === "permission-reply" && typeof message.id === "string" && typeof message.reply === "string") {
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

export default {
	port: 3000,
	fetch: app.fetch,
	websocket,
};
