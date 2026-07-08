import { GraphAccess } from '../types';

/**
 * Reverse-dependency lookup: every chain from a project's direct dependencies down to a target
 * package, answering "why is this here?". Works on the provider-agnostic {@link GraphAccess}.
 */

export interface DependencyPathStep {
  name: string;
  version: string;
}

export interface DependencyPath {
  /** From a direct dependency (first) down to the target package (last). */
  steps: DependencyPathStep[];
  /** True when the chain starts at a dev dependency. */
  isDev: boolean;
}

export interface WhyResult {
  paths: DependencyPath[];
  /** True when enumeration stopped at the cap — more chains exist than shown. */
  truncated: boolean;
  /** Distinct resolved versions of the target found in the graph. */
  targetVersions: string[];
}

export const DEFAULT_MAX_PATHS = 200;

export function findDependencyPaths(
  graph: GraphAccess,
  targetName: string,
  maxPaths: number = DEFAULT_MAX_PATHS
): WhyResult {
  const want = targetName.toLowerCase();
  const allKeys = graph.keys();

  const targetKeys = new Set<string>();
  const targetVersions = new Set<string>();
  for (const key of allKeys) {
    const entry = graph.entry(key);
    if (entry && entry.name.toLowerCase() === want) {
      targetKeys.add(key);
      targetVersions.add(entry.version);
    }
  }
  if (targetKeys.size === 0) {
    return { paths: [], truncated: false, targetVersions: [] };
  }

  // Reverse reachability: only walk forward through nodes that can actually reach the target,
  // which keeps the DFS linear in the relevant subgraph instead of the whole tree.
  const parents = new Map<string, string[]>();
  for (const key of allKeys) {
    for (const child of graph.childKeys(key)) {
      let list = parents.get(child);
      if (!list) {
        list = [];
        parents.set(child, list);
      }
      list.push(key);
    }
  }
  const canReach = new Set<string>(targetKeys);
  const queue = [...targetKeys];
  while (queue.length > 0) {
    const key = queue.pop()!;
    for (const parent of parents.get(key) ?? []) {
      if (!canReach.has(parent)) {
        canReach.add(parent);
        queue.push(parent);
      }
    }
  }

  const paths: DependencyPath[] = [];
  let truncated = false;

  const step = (key: string): DependencyPathStep => {
    const entry = graph.entry(key);
    return { name: entry?.name ?? key, version: entry?.version ?? '' };
  };

  const walk = (key: string, trail: string[], isDev: boolean): void => {
    if (paths.length >= maxPaths) {
      truncated = true;
      return;
    }
    const nextTrail = [...trail, key];
    if (targetKeys.has(key)) {
      paths.push({ steps: nextTrail.map(step), isDev });
      return; // a chain ends at its first hit of the target
    }
    for (const child of graph.childKeys(key)) {
      if (!canReach.has(child) || nextTrail.includes(child)) {
        continue; // irrelevant branch, or a cycle
      }
      walk(child, nextTrail, isDev);
    }
  };

  for (const root of graph.roots) {
    if (canReach.has(root.key)) {
      walk(root.key, [], root.isDev);
    }
  }

  // Shortest chains first — they're the most actionable ("bump X to move this").
  paths.sort((a, b) => a.steps.length - b.steps.length || pathLabel(a).localeCompare(pathLabel(b)));
  return { paths, truncated, targetVersions: [...targetVersions].sort() };
}

function pathLabel(p: DependencyPath): string {
  return p.steps.map((s) => s.name).join('>');
}
