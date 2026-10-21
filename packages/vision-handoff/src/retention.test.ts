import { expect, it } from "vitest";
import { selectExpired } from "./retention.js";

it("expires exactly at seven days, not future/recent mtimes; zero retains forever", () => {
  const now = 8 * 86_400_000;
  const files = [0, 86_400_000, 86_400_001, now + 1].map((mtimeMs) => ({
    path: String(mtimeMs),
    mtimeMs,
  }));
  expect(selectExpired(files, now, 7)).toEqual(files.slice(0, 2));
  expect(selectExpired(files, now, 0)).toEqual([]);
});
