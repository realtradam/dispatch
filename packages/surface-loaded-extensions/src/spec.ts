import type { Manifest } from "@dispatch/kernel";
import type { CustomField, StatField, SurfaceSpec } from "@dispatch/ui-contract";

/**
 * The typed payload of the `rendererId: "table"` custom field (CR-1). Exported
 * so a client renderer narrows `CustomField.payload` via this symbol instead of
 * a blind `unknown`. Each row aligns cell-for-cell to `columns`.
 */
export interface TablePayload {
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | boolean>>;
}

/** The renderer id clients dispatch on for the extensions table. */
export const TABLE_RENDERER_ID = "table";

/**
 * Pure core — builds the SurfaceSpec for the loaded-extensions surface.
 * Zero I/O, zero ambient state. Decision logic only: input → output.
 *
 * Emits a "Loaded" count stat plus ONE `custom`/"table" field enumerating EVERY
 * loaded extension (all trust tiers) as real columns (CR-1). A client without a
 * "table" renderer gracefully skips the field and still sees the count.
 */
export function buildLoadedExtensionsSpec(manifests: readonly Manifest[]): SurfaceSpec {
  const count: StatField = { kind: "stat", label: "Loaded", value: String(manifests.length) };

  const payload: TablePayload = {
    columns: ["Name", "Version", "Trust", "Activation"],
    rows: manifests.map((manifest) => [
      manifest.name,
      manifest.version,
      manifest.trust,
      // Activation is optional in the manifest; "eager" is the declared default.
      manifest.activation ?? "eager",
    ]),
  };

  const table: CustomField = {
    kind: "custom",
    rendererId: TABLE_RENDERER_ID,
    payload,
  };

  return {
    id: "loaded-extensions",
    region: "side",
    title: "Loaded Extensions",
    fields: [count, table],
  };
}
