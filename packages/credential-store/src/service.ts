import { defineService } from "@dispatch/kernel";
import type { CredentialStore } from "./registry.js";

export const credentialStoreHandle = defineService<CredentialStore>("credential-store/registry");
