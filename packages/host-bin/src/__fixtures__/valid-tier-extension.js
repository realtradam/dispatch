/**
 * Test fixture for `load-external.test.ts`: a module that exposes a valid
 * `Extension` with a VALID manifest `tier` (one of the three values). The
 * tier gate must pass it through and load it. Plain `.js` on purpose: the
 * fixture is a stand-in for an external (out-of-repo) module and `tsc` must
 * not type-check it as repo source.
 */
export const extension = {
  manifest: {
    id: "tiered-external",
    name: "Tiered External",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    tier: "standard",
    trust: "external",
  },
  activate: () => {},
};
