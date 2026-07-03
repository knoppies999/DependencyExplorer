import { PackageId } from '../types';

/** A resolved edge to a dependency: its declared name and the graph key it resolves to. */
export interface DepRef {
  name: string;
  /** Undefined when the dependency couldn't be resolved in the lockfile (shown as "missing"). */
  key?: string;
}

export interface GraphEntry {
  name: string;
  version: string;
  /** True for dev-only packages (best-effort; used for the "dev" flag on nodes). */
  dev?: boolean;
}

/**
 * The resolved dependency graph a provider walks, independent of lockfile format. Both
 * `package-lock.json` (npm) and `pnpm-lock.yaml` (pnpm) are parsed into this shape so the tree,
 * cycle detection and vulnerability closure operate on opaque string keys the same way.
 */
export interface ResolvedGraph {
  directProd: DepRef[];
  directDev: DepRef[];
  entry(key: string): GraphEntry | undefined;
  children(key: string): DepRef[];
  /** Every resolved package with a version (for OSV queries). */
  allPackages(): PackageId[];
  /** All package keys in the graph (for the vulnerability closure). */
  keys(): string[];
}
