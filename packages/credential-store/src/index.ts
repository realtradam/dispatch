export { createCredentialStoreExtension, manifest } from "./extension.js";
export type {
	Credential,
	CredentialStore,
	CredentialStoreDeps,
	ResolvedModel,
} from "./registry.js";
export { createCredentialStore } from "./registry.js";
export { credentialStoreHandle } from "./service.js";
