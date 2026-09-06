/**
 * Test fixture for `load-external.test.ts`: a module that exposes a valid
 * `Extension` EXCEPT its manifest `tier` is not one of the three valid
 * values ("kernel" is NOT a tier — the kernel hosts extensions, it is not
 * one). `loadExternalExtensions` must reject and skip it. Plain `.js` on
 * purpose: `tsc` must not type-check the deliberately invalid manifest.
 */
export const extension = {
  manifest: {
    id: "invalid-tier-external",
    name: "Invalid Tier External",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    tier: "kernel",
    trust: "external",
  },
  activate: () => {},
};
