import type { Logger } from "@dispatch/kernel";
import type { CreateServerOptions } from "./server-options.js";

/** Per-app defaults plus the ORIGINAL options object: never snapshot reactive getters. */
export interface RouteOptions {
  readonly config: CreateServerOptions;
  readonly log: Logger;
  readonly generateId: () => string;
  readonly now: () => number;
}
