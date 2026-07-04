import { parseAllDocuments } from 'yaml';
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

interface LockfileDoc {
  lockfileVersion?: string | number;
  dependencies?: ImporterSection['dependencies'];
  devDependencies?: ImporterSection['devDependencies'];
  importers?: Record<string, ImporterSection>;
  packages?: Record<string, PackageValue>;
  snapshots?: Record<string, PackageValue>;
}

/**
 * Parse a `pnpm-lock.yaml` (v6, v9, or the pnpm 11 multi-document layout) into one ResolvedGraph
 * per importer (workspace package). v6 keeps the dependency graph inline in `packages` (keys
 * prefixed with `/`); v9 splits package metadata (`packages`) from the resolved graph (`snapshots`,
 * keys without a prefix). pnpm 11 keeps `lockfileVersion: '9.0'` but splits the file into multiple
 * YAML documents — an "env" document (config/packageManager deps) plus the real project document —
 * so we select the document that actually carries the dependency graph. Throws for unsupported
 * lockfile versions so the provider can surface a friendly project error.
 */
export function buildPnpmGraphs(lockText: string): PnpmImporterGraph[] {
  const doc = selectProjectLockfile(lockText);

  const major = parseInt(String(doc.lockfileVersion ?? ''), 10);
  if (major !== 6 && major !== 9) {
    throw new Error(
      `pnpm lockfile version ${doc.lockfileVersion ?? '?'} is not supported — run "pnpm install" with pnpm 8, 9, 10 or 11.`
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

/**
 * Pick the project lockfile out of a (possibly multi-document) pnpm-lock.yaml. Single-document
 * lockfiles (v6/v9) return their only document. pnpm 11 writes a multi-document file: an "env"
 * document holding `configDependencies`/`packageManagerDependencies` and the real project document
 * holding `importers`/`packages`/`snapshots` (or top-level `dependencies` for a non-workspace repo).
 * We select whichever document actually carries the dependency graph.
 */
function selectProjectLockfile(lockText: string): LockfileDoc {
  const docs = parseAllDocuments(lockText)
    .map((d) => d.toJSON() as unknown)
    .filter((d): d is LockfileDoc => !!d && typeof d === 'object');
  if (docs.length === 0) {
    return {};
  }
  const project = docs.find(
    (d) => d.importers || d.packages || d.snapshots || d.dependencies || d.devDependencies
  );
  return project ?? docs[docs.length - 1];
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
