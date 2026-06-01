// `/notifications` — ntfy.sh config + test-send route.

import {
	defaultNtfyConfig,
	loadNtfyConfig,
	type NotificationEventType,
	NTFY_EVENT_TYPES,
	type NtfyConfig,
	normalizeNtfyConfig,
	redactNtfyConfig,
	saveNtfyConfig,
	sendNtfy,
	validateTopicUrl,
} from "@dispatch/core";
import { Hono } from "hono";

export const notificationsRoutes = new Hono();

notificationsRoutes.get("/", (c) => {
	const config = loadNtfyConfig();
	return c.json({
		config: redactNtfyConfig(config),
		eventTypes: NTFY_EVENT_TYPES,
		defaults: defaultNtfyConfig(),
	});
});

notificationsRoutes.put("/", async (c) => {
	const body = await c.req.json<Partial<NtfyConfig> & { authToken?: string }>();
	const existing = loadNtfyConfig();

	// `authToken === ""` ⇒ explicit clear; `authToken === undefined` ⇒ keep
	// the existing token (the GET response redacts it, so the frontend doesn't
	// have it to send back). Any other string ⇒ replace.
	let nextAuthToken = existing.authToken;
	if (typeof body.authToken === "string") nextAuthToken = body.authToken;

	const merged = normalizeNtfyConfig({
		enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
		topicUrl: typeof body.topicUrl === "string" ? body.topicUrl : existing.topicUrl,
		authToken: nextAuthToken,
		events: { ...existing.events, ...(body.events ?? {}) },
	});

	if (merged.enabled) {
		const err = validateTopicUrl(merged.topicUrl);
		if (err) return c.json({ error: err }, 400);
	}

	saveNtfyConfig(merged);
	return c.json({ config: redactNtfyConfig(merged) });
});

notificationsRoutes.post("/test", async (c) => {
	const config = loadNtfyConfig();
	if (!config.enabled) {
		return c.json({ ok: false, error: "Notifications are disabled" }, 400);
	}
	const err = validateTopicUrl(config.topicUrl);
	if (err) return c.json({ ok: false, error: err }, 400);

	// Use a real event type so the per-event toggle is honored when wiring
	// is tested end-to-end; pick `turn-completed` since it's the most
	// common enabled-by-default event.
	const eventType: NotificationEventType = "turn-completed";
	if (!config.events[eventType]) {
		return c.json(
			{ ok: false, error: `Event type "${eventType}" is disabled — enable it to test.` },
			400,
		);
	}

	const result = await sendNtfy(config, {
		type: eventType,
		title: "Dispatch test notification",
		message: "If you can see this, ntfy.sh notifications are wired up correctly.",
		tags: ["bell"],
	});
	if (!result.ok) return c.json(result, 502);
	return c.json(result);
});
