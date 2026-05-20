import { Hono } from "hono";
import type { DispatchConfig } from "@dispatch/core";

let getConfig: () => DispatchConfig = () => ({ permissions: {} });

export function setConfigGetter(getter: () => DispatchConfig): void {
	getConfig = getter;
}

const configRoutes = new Hono();

configRoutes.get("/", (c) => {
	const config = getConfig();

	// Strip env field values from keys for security
	const safeConfig: DispatchConfig = {
		...config,
		keys: config.keys?.map((key) => ({
			...key,
			env: "***",
		})),
	};

	return c.json({ config: safeConfig });
});

export { configRoutes };
