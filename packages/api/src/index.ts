import { createBunWebSocket } from "hono/bun";
import { agentManager, app } from "./app.js";

const { upgradeWebSocket, websocket } = createBunWebSocket();

app.get(
	"/ws",
	upgradeWebSocket((_c) => {
		return {
			onOpen(_event, ws) {
				// Send current status immediately
				ws.send(JSON.stringify({ type: "status", status: agentManager.getStatus() }));

				const unsubscribe = agentManager.onEvent((event) => {
					ws.send(JSON.stringify(event));
				});

				// Store unsubscribe fn on the raw socket for cleanup
				(ws as unknown as { _unsub?: () => void })._unsub = unsubscribe;
			},
			onClose(_event, ws) {
				const unsub = (ws as unknown as { _unsub?: () => void })._unsub;
				if (unsub) {
					unsub();
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
