import type { Manifest } from "../contracts/extension.js";

export function resolveActivationOrder(manifests: readonly Manifest[]): Manifest[] {
  const byId = new Map<string, Manifest>();
  for (const m of manifests) {
    if (byId.has(m.id)) {
      throw new Error(`Duplicate extension id: "${m.id}"`);
    }
    byId.set(m.id, m);
  }

  for (const m of manifests) {
    for (const dep of m.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`Extension "${m.id}" depends on "${dep}", which is not available.`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const m of manifests) {
    inDegree.set(m.id, 0);
    dependents.set(m.id, []);
  }

  for (const m of manifests) {
    for (const dep of m.dependsOn ?? []) {
      const list = dependents.get(dep);
      if (list !== undefined) list.push(m.id);
      inDegree.set(m.id, (inDegree.get(m.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const result: Manifest[] = [];
  let idx = 0;
  while (idx < queue.length) {
    const id = queue[idx];
    if (id === undefined) break;
    idx++;
    const m = byId.get(id);
    if (m === undefined) continue;
    result.push(m);
    for (const dep of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  if (result.length !== manifests.length) {
    const remaining = manifests.filter((m) => !result.some((r) => r.id === m.id));
    const ids = remaining.map((m) => m.id).join(", ");
    throw new Error(`Dependency cycle detected among extensions: ${ids}`);
  }

  return result;
}
