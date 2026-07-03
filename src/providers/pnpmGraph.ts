import { parse as parseYaml } from 'yaml';
import { DepRef, GraphEntry, ResolvedGraph } from './resolvedGraph';

export interface PnpmImporterGraph {
  /** Importer path relative to the lockfile dir ('.' is the workspace root). */
  importerPath: string;
  graph: ResolvedGraph;
}

interface ImporterSection {
  dependencies?: Record<string, { specifier?: string; version?: string } | string>;
  devDependencies?: Record<string, { specifier?: string; version?: string } | string>;
}

interface PackageValue {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Parse a `pnpm-lock.yaml` (v6 or v9) into one ResolvedGraph per importer (workspace package).
 * v6 keeps the dependency graph inline in `packages` (keys prefixed with `/`); v9 splits package
 * metadata (`packages`) from the resolved graph (`snapshots`, keys without a prefix). Throws for
 * unsupported lockfile versions so the provider can surface a friendly project error.
 */
export function buildPnpmGraphs(lockText: string): PnpmImporterGraph[] {
  const doc = (parseYaml(lockText) ?? {}) as {
    lockfileVersion?: string | number;
    dependencies?: ImporterSection['dependencies'];
    devDependencies?: ImporterSection['devDependencies'];
    importers?: Record<string, ImporterSection>;
    packages?: Record<string, PackageValue>;
    snapshots?: Record<string, PackageValue>;
  };

  const major = parseInt(String(doc.lockfileVersion ?? ''), 10);
  if (major !== 6 && major !== 9) {
    throw new Error(
      `pnpm lockfile version ${doc.lockfileVersion ?? '?'} is not supported — run "pnpm install" with pnpm 8 or 9.`
    );
  }

  const prefix = major === 6 ? '/' : '';
  const source = (major === 6 ? doc.packages : doc.snapshots) ?? {};

  // Shared across all importers: entry (name/version) and resolved child edges per graph key.
  const entries = new Map<string, GraphEntry>();
  const childrenByKey = new Map<string, DepRef[]>();
  for (const [rawKey, value] of Object.entries(source)) {
    const parsed = parseNameVersion(rawKey, prefix);
    if (!parsed) {
      continue;
    }
    entries.set(rawKey, parsed);
    const edges: DepRef[] = [];
    for (const [depName, verRef] of Object.entries({
      ...(value.dependencies ?? {}),
      ...(value.optionalDependencies ?? {}),
    })) {
      edges.push({ name: depName, key: childKey(prefix, depName, verRef) });
    }
    childrenByKey.set(rawKey, edges);
  }

  const importers: Record<string, ImporterSection> =
    doc.importers ?? { '.': { dependencies: doc.dependencies, devDependencies: doc.devDependencies } };

  return Object.entries(importers).map(([importerPath, section]) => {
    const directProd = directRefs(prefix, section.dependencies);
    const directDev = directRefs(prefix, section.devDependencies);
    // The `packages`/`snapshots` maps are shared across all importers in a workspace, so scope this
    // importer to only the packages reachable from ITS own direct deps — otherwise the tree, OSV
    // queries and the project vulnerability badge would attribute other importers' packages here.
    const reachable = reachableKeys([...directProd, ...directDev], childrenByKey);
    const graph: ResolvedGraph = {
      directProd,
      directDev,
      entry: (key) => entries.get(key),
      children: (key) => childrenByKey.get(key) ?? [],
      allPackages: () =>
        [...reachable].flatMap((key) => {
          const e = entries.get(key);
          return e ? [{ name: e.name, version: e.version }] : [];
        }),
      keys: () => [...reachable],
    };
    return { importerPath, graph };
  });
}

/** Keys reachable from a set of direct deps by following child edges (cycle-safe). */
function reachableKeys(direct: DepRef[], childrenByKey: Map<string, DepRef[]>): Set<string> {
  const seen = new Set<string>();
  const stack = direct.flatMap((ref) => (ref.key ? [ref.key] : []));
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    for (const child of childrenByKey.get(key) ?? []) {
      if (child.key && !seen.has(child.key)) {
        stack.push(child.key);
      }
    }
  }
  return seen;
}

function directRefs(prefix: string, section: ImporterSection['dependencies']): DepRef[] {
  if (!section) {
    return [];
  }
  const refs: DepRef[] = [];
  for (const [name, info] of Object.entries(section)) {
    const verRef = typeof info === 'string' ? info : info?.version;
    refs.push({ name, key: verRef ? childKey(prefix, name, verRef) : undefined });
  }
  return refs;
}

/** Build the graph key a dependency ref points at, or undefined for workspace links. */
function childKey(prefix: string, name: string, verRef: string): string | undefined {
  if (!verRef || verRef.startsWith('link:')) {
    return undefined;
  }
  return `${prefix}${name}@${verRef}`;
}

/** Parse `name` and `version` out of a package/snapshot key like `/@scope/pkg@1.2.3(peer@4)`. */
function parseNameVersion(rawKey: string, prefix: string): GraphEntry | undefined {
  let s = rawKey;
  if (prefix && s.startsWith(prefix)) {
    s = s.slice(prefix.length);
  }
  const paren = s.indexOf('(');
  const base = paren === -1 ? s : s.slice(0, paren);
  const at = base.lastIndexOf('@');
  if (at <= 0) {
    return undefined;
  }
  return { name: base.slice(0, at), version: base.slice(at + 1) };
}
