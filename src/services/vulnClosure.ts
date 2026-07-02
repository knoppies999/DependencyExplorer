/**
 * Compute the "subtree contains a vulnerability" set for a dependency graph.
 *
 * A key belongs to the closure when it can reach a directly-vulnerable key by
 * following child edges — i.e. it is the vulnerable package itself or an ancestor
 * of one. This is plain reverse reachability from the vulnerable nodes, which is
 * correct regardless of cycles or the order keys are visited in. (A recursive
 * DFS that memoizes while also cutting cycles on a stack can cache a node as
 * "clean" when it was only reached mid-cycle, dropping the warning on ancestors
 * further down the tree.)
 */
export function computeVulnClosure(
  keys: Iterable<string>,
  getChildren: (key: string) => Iterable<string>,
  isVulnerable: (key: string) => boolean
): Set<string> {
  const parents = new Map<string, Set<string>>();
  const closure = new Set<string>();
  const queue: string[] = [];

  for (const key of keys) {
    if (isVulnerable(key) && !closure.has(key)) {
      closure.add(key);
      queue.push(key);
    }
    for (const child of getChildren(key)) {
      let ps = parents.get(child);
      if (!ps) {
        ps = new Set<string>();
        parents.set(child, ps);
      }
      ps.add(key);
    }
  }

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const ps = parents.get(current);
    if (!ps) {
      continue;
    }
    for (const parent of ps) {
      if (!closure.has(parent)) {
        closure.add(parent);
        queue.push(parent);
      }
    }
  }

  return closure;
}
