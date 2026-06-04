import type { AuthContract, Extension } from "@dispatch/kernel";
import { resolveApiKeyCredentials } from "./resolver.js";

export const apikeyAuth: AuthContract = {
	id: "apikey",
	resolve: async () =>
		resolveApiKeyCredentials(process.env as Readonly<Record<string, string | undefined>>),
};

export const extension: Extension = {
	manifest: {
		id: "auth-apikey",
		name: "API Key Auth",
		version: "0.0.0",
		apiVersion: "^0.1.0",
		trust: "bundled",
		contributes: { auth: ["apikey"] },
	},
	activate(host) {
		host.defineAuth(apikeyAuth);
	},
};
