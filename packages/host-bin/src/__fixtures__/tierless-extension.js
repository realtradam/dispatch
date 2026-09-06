/**
 * Test fixture for `load-external.test.ts`: a module that exposes a valid
 * `Extension` EXCEPT its manifest is MISSING the required `tier` field
 * (required since plan 02). `loadExternalExtensions` must reject and skip it
 * — nothing tierless may reach the `/plugins` contract. Plain `.js` on
 * purpose: `tsc` must not type-check the deliberately invalid manifest.
 */
export const extension = {
  manifest: {
    id: "tierless-external",
    name: "Tierless External",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    trust: "external",
  },
  activate: () => {},
};
