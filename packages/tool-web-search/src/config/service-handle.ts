import type { ServiceHandle } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import type { SearchConfigService } from "./search-config.js";

/**
 * Typed service handle the `tool-web-search` extension provides and the
 * transport routes consume. Mirrors `heartbeatServiceHandle`.
 */
export const searchConfigServiceHandle: ServiceHandle<SearchConfigService> =
  defineService<SearchConfigService>("search-config");
