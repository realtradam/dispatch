/**
 * Root finder — nearest ancestor containing a marker file, bounded at cwd.
 */

export async function findRoot(
  startDir: string,
  cwd: string,
  markers: readonly string[],
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const normalizedStart = normalizePath(startDir);
  const normalizedCwd = normalizePath(cwd);

  let current = normalizedStart;
  while (true) {
    for (const marker of markers) {
      const markerPath = current === "/" ? `/${marker}` : `${current}/${marker}`;
      if (await exists(markerPath)) {
        return current;
      }
    }
    if (current === normalizedCwd || current === "/") {
      return normalizedCwd;
    }
    const parent = getParent(current);
    if (parent === current) return normalizedCwd;
    current = parent;
  }
}

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || "/";
}

function getParent(p: string): string {
  if (p === "/") return "/";
  const lastSlash = p.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return p.slice(0, lastSlash) || "/";
}
