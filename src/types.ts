export type Ecosystem = 'npm' | 'NuGet';

export interface VulnInfo {
  id: string;
}

export interface PackageId {
  name: string;
  version: string;
}

/** Where a given package sits within one project's graph. */
export interface PackageLocation {
  project: Project;
  isDirect: boolean;
  version: string;
}

/** A package that appears in two or more projects of the same ecosystem. */
export interface DuplicatePackage {
  ecosystem: Ecosystem;
  name: string;
  locations: PackageLocation[];
}

export interface Project {
  ecosystem: Ecosystem;
  /** Path to the editable manifest: package.json or the .csproj file. */
  manifestPath: string;
  name: string;
  /** When set, the project node shows this message instead of dependencies. */
  error?: string;
  /**
   * npm ecosystem only: which package manager owns this project. Drives the install command and
   * where transitive overrides are written (npm → this package.json's "overrides"; pnpm → the
   * workspace-root package.json's "pnpm.overrides").
   */
  packageManager?: 'npm' | 'pnpm';
  /** pnpm only: directory of the root package.json that owns `pnpm.overrides` (workspace root). */
  workspaceRoot?: string;
}

export interface ProjectNode {
  kind: 'project';
  project: Project;
}

export interface MessageNode {
  kind: 'message';
  project: Project;
  text: string;
}

export interface DependencyNode {
  kind: 'dependency';
  project: Project;
  /** Provider-internal resolution key (lockfile path for npm, lowercased id for NuGet). */
  key: string;
  name: string;
  version: string;
  isDirect: boolean;
  isDev: boolean;
  hasChildren: boolean;
  /** This node closes a cycle in the graph; rendered as a leaf. */
  circular?: boolean;
  /** Vulnerabilities affecting this exact package version. */
  vulns: VulnInfo[];
  /** True when a package somewhere in this node's subtree is vulnerable. */
  subtreeVulnerable: boolean;
  /** Resolution keys of ancestors, used for cycle detection during lazy expansion. */
  ancestorKeys: string[];
}

export type TreeNode = ProjectNode | MessageNode | DependencyNode;

/**
 * Provider-agnostic view of a project's resolved dependency graph, used for reverse-dependency
 * ("why is this here?") walks without exposing lockfile-specific internals.
 */
export interface GraphAccess {
  /** Direct dependencies that resolved to a graph node. */
  roots: { key: string; isDev: boolean }[];
  entry(key: string): { name: string; version: string } | undefined;
  /** Resolved child keys only (unresolved/missing edges are omitted). */
  childKeys(key: string): string[];
  keys(): string[];
}

export interface DependencyProvider {
  readonly ecosystem: Ecosystem;
  /** Find and parse all projects of this ecosystem in the workspace. */
  scan(): Promise<Project[]>;
  getDirectDependencies(project: Project): DependencyNode[];
  getChildDependencies(node: DependencyNode): DependencyNode[];
  /** Every resolved package in the project's graph (for vulnerability queries). */
  getAllPackages(project: Project): PackageId[];
  /** Whether a package (by name) is present in this project, and how. Undefined if absent. */
  locate(project: Project, name: string): { isDirect: boolean; version: string } | undefined;
  /** Resolved target framework, if the ecosystem has one (used to preview NuGet dependency groups). */
  getTargetFramework?(project: Project): string | undefined;
  /** Recompute which subtrees contain a vulnerable package (call after OSV results arrive). */
  applyVulnerabilities(project: Project): void;
  /** Resolved-graph access for reverse-dependency ("why is this here?") walks. */
  getGraph?(project: Project): GraphAccess | undefined;
}
