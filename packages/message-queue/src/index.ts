/**
 * @dispatch/message-queue — the per-conversation message queue for mid-turn
 * steering. Owns the queue state + a per-conversation `custom` surface; the
 * session-orchestrator drains it via `messageQueueHandle`. The queue is
 * transient (in-memory, per-conversation, only meaningful during generation);
 * the surface is the ONLY way the frontend reads queue state.
 */

export type { QueuedMessage, QueuePayload } from "@dispatch/wire";
export { extension, manifest } from "./extension.js";
export {
	buildQueueSpec,
	combine,
	drain,
	enqueue,
	getQueue,
	MESSAGE_QUEUE_RENDERER_ID,
	MESSAGE_QUEUE_SURFACE_ID,
	type MessageQueueState,
	type QueueDeps,
} from "./pure.js";
export {
	createMessageQueueService,
	type MessageQueueDeps,
	type MessageQueueService,
	messageQueueHandle,
} from "./service.js";
