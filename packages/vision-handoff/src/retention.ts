/** Files exactly at the cutoff expire; zero disables age-based deletion. */
export function selectExpired<T extends { path: string; mtimeMs: number }>(
  files: readonly T[],
  nowMs: number,
  retentionDays: number,
): T[] {
  if (retentionDays <= 0) return [];
  const cutoff = nowMs - retentionDays * 86_400_000;
  return files.filter((file) => file.mtimeMs <= cutoff);
}
