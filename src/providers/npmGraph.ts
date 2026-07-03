import { PackageId } from '../types';
import { DepRef, GraphEntry, ResolvedGraph } from './resolvedGraph';

interface LockPackage {
  name?: string;
  version?: string;
  dev?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

type PackagesMap = Record<string, LockPackage>;

/**
 * Build a ResolvedGraph from a parsed `package-lock.json` v2/v3 `packages` map. Key "" is the
 * root project; other keys look like `node_modules/x` or `node_modules/a/node_modules/x`.
 * Resolution is node_modules walk-up (a dependency is found in the requester's own node_modules,
 * else by walking up parent scopes) — this must stay correct (see ARCHITECTURE.md / CLAUDE.md).
 */
export function buildNpmGraph(
  packages: PackagesMap,
  directProdNames: string[],
  directDevNames: string[]
): ResolvedGraph {
  const resolve = (fromKey: string, depName: string): string | undefined => {
    let scope = fromKey;
    for (;;) {
      const candidate = scope ? `${scope}/node_modules/${depName}` : `node_modules/${depName}`;
      if (packages[candidate]) {
        return candidate;
      }
      if (!scope) {
        return undefined;
      }
      const idx = scope.lastIndexOf('/node_modules/');
      scope = idx === -1 ? '' : scope.slice(0, idx);
    }
  };

  const childNames = (entry: LockPackage): string[] => [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
  ];

  const refsFrom = (fromKey: string, names: string[]): DepRef[] =>
    names.map((name) => ({ name, key: resolve(fromKey, name) }));

  return {
    directProd: refsFrom('', directProdNames),
    directDev: refsFrom('', directDevNames),
    entry(key: string): GraphEntry | undefined {
      const e = packages[key];
      if (!e) {
        return undefined;
      }
      return { name: e.name ?? nameFromKey(key), version: e.version ?? '(not installed)', dev: e.dev };
    },
    children(key: string): DepRef[] {
      const e = packages[key];
      return e ? refsFrom(key, childNames(e)) : [];
    },
    allPackages(): PackageId[] {
      const result: PackageId[] = [];
      for (const [key, e] of Object.entries(packages)) {
        if (!key || !e.version || e.link) {
          continue;
        }
        result.push({ name: e.name ?? nameFromKey(key), version: e.version });
      }
      return result;
    },
    keys(): string[] {
      return Object.keys(packages).filter((k) => k);
    },
  };
}

function nameFromKey(key: string): string {
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  return idx === -1 ? key : key.slice(idx + marker.length);
}
