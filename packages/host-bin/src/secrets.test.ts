import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("the real unconfigured host secrets reject mutations without booting", () => {
  // main.ts imports bun:sqlite: exercise its actual exported adapter in Bun,
  // never boot() or open an application database/server.
  const output = execFileSync(
    "bun",
    [
      "--eval",
      `
    import { createEmptySecrets } from "./packages/host-bin/src/main.ts";
    const secrets = createEmptySecrets();
    if (await secrets.get("test-key") !== null) throw new Error("unexpected read");
    for (const mutate of [() => secrets.set("test-key", "fixture"), () => secrets.delete("test-key")]) {
      try { await mutate(); throw new Error("mutation succeeded"); }
      catch (error) { if (error.message !== "secrets store not configured") throw error; }
    }
    console.log("verified");
  `,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(output.trim()).toBe("verified");
});

it("exposes only the allowlisted Inco environment key and rejects all mutations", async () => {
  const { createEnvSecrets } = await import("./secrets.js");
  const secrets = createEnvSecrets({ INCO_API_KEY: "fixture-key", OTHER_SECRET: "hidden" });
  expect(await secrets.get("INCO_API_KEY")).toBe("fixture-key");
  expect(await secrets.get("OTHER_SECRET")).toBeNull();
  expect(await createEnvSecrets({}).get("INCO_API_KEY")).toBeNull();
  expect(await createEnvSecrets({ INCO_API_KEY: "  " }).get("INCO_API_KEY")).toBeNull();
  await expect(secrets.set("INCO_API_KEY", "replacement")).rejects.toThrow(
    "secrets store not configured",
  );
  await expect(secrets.delete("INCO_API_KEY")).rejects.toThrow("secrets store not configured");
});
