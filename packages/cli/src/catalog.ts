/**
 * Pure catalog formatter — zero I/O.
 *
 * Formats a ModelsResponse into one model name per line.
 */

import type { ModelsResponse } from "@dispatch/transport-contract";

export function formatCatalog(r: ModelsResponse): string {
  return r.models.join("\n");
}
