import { defineService } from "@dispatch/kernel";
import type { SurfaceRegistry } from "./registry.js";

export const surfaceRegistryHandle = defineService<SurfaceRegistry>("surface-registry/registry");
