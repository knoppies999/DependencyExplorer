import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyNode, DependencyProvider, PackageId, Project } from '../types';
import { OsvService } from '../services/osvService';
import { computeVulnClosure } from '../services/vulnClosure';
import { DepRef, ResolvedGraph } from './resolvedGraph';
import { buildNpmGraph } from './npmGraph';
import { buildPnpmGraphs } from './pnpmGraph';

interface NpmState {
  graph: ResolvedGraph;
  /** Graph keys whose subtree (including the package itself) contains a vulnerability. */
  vulnClosure: Set<string>;
}

/**
 * Provider for the npm ecosystem, covering both npm (`package-lock.json`) and pnpm
 * (`pnpm-lock.yaml`, including workspaces). Both lockfiles are parsed into a common
 * {@link ResolvedGraph}; everything below the scan walks that graph identically.
 */
export class NpmProvider implements DependencyProvider {
  readonly ecosystem = 'npm' as const;
  private states = new Map<string, NpmState>();

  constructor(private osv: OsvService) {}

  async scan(): Promise<Project[]> {
    this.states.clear();
    const projects: Project[] = [];
    const claimed = new Set<string>(); // package.json paths handled as pnpm importers

    // pnpm first, so its workspace importers claim their package.json files.
    const pnpmLocks = await vscode.workspace.findFiles('**/pnpm-lock.yaml', '**/node_modules/**');
    for (const uri of pnpmLocks) {
      this.scanPnpmWorkspace(uri.fsPath, projects, claimed);
    }

    const manifests = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**');
    for (const uri of manifests) {
      const manifestPath = uri.fsPath;
      if (claimed.has(manifestPath)) {
        continue;
      }
      this.scanNpmProject(manifestPath, projects);
    }
    return projects;
  }

  private scanNpmProject(manifestPath: string, projects: Project[]): void {
    const dir = path.dirname(manifestPath);
    let name = path.basename(dir);
    let directProd: string[] = [];
    let directDev: string[] = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      name = pkg.name || name;
      directProd = Object.keys(pkg.dependencies ?? {});
      directDev = Object.keys(pkg.devDependencies ?? {});
    } catch {
      return;
    }
    if (directProd.length === 0 && directDev.length === 0) {
      return;
    }

    const project: Project = { ecosystem: 'npm', manifestPath, name, packageManager: 'npm' };
    const lockPath = path.join(dir, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
      project.error =
        'No package-lock.json or pnpm-lock.yaml found — run "npm install" or "pnpm install" to generate one.';
    } else {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!lock.packages) {
          project.error =
            'Lockfile version 1 is not supported — run "npm install" with npm 7+ to upgrade it.';
        } else {
          this.states.set(manifestPath, {
            graph: buildNpmGraph(lock.packages, directProd, directDev),
            vulnClosure: new Set(),
          });
        }
      } catch (err) {
        project.error = `Failed to parse package-lock.json: ${err instanceof Error ? err.message : err}`;
      }
    }
    projects.push(project);
  }

  private scanPnpmWorkspace(lockPath: string, projects: Project[], claimed: Set<string>): void {
    const lockDir = path.dirname(lockPath);
    let importers;
    try {
      importers = buildPnpmGraphs(fs.readFileSync(lockPath, 'utf8'));
    } catch (err) {
      // Surface as a project error on the root package.json (if any).
      const rootManifest = path.join(lockDir, 'package.json');
      if (fs.existsSync(rootManifest)) {
        claimed.add(rootManifest);
        projects.push({
          ecosystem: 'npm',
          manifestPath: rootManifest,
          name: this.readPkgName(rootManifest) ?? path.basename(lockDir),
          packageManager: 'pnpm',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    for (const { importerPath, graph } of importers) {
      const importerDir = path.resolve(lockDir, importerPath);
      const manifestPath = path.join(importerDir, 'package.json');
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      claimed.add(manifestPath);
      if (graph.directProd.length === 0 && graph.directDev.length === 0) {
        continue;
      }
      this.states.set(manifestPath, { graph, vulnClosure: new Set() });
      projects.push({
        ecosystem: 'npm',
        manifestPath,
        name: this.readPkgName(manifestPath) ?? path.basename(importerDir),
        packageManager: 'pnpm',
        workspaceRoot: lockDir,
      });
    }
  }

  private readPkgName(manifestPath: string): string | undefined {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).name || undefined;
    } catch {
      return undefined;
    }
  }

  getDirectDependencies(project: Project): DependencyNode[] {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return [];
    }
    const nodes: DependencyNode[] = [];
    for (const { refs, isDev } of [
      { refs: state.graph.directProd, isDev: false },
      { refs: state.graph.directDev, isDev: true },
    ]) {
      for (const ref of refs) {
        nodes.push(this.makeNode(project, state, ref, true, isDev, []));
      }
    }
    return nodes.sort((a, b) => a.name.localeCompare(b.name));
  }

  getChildDependencies(node: DependencyNode): DependencyNode[] {
    const state = this.states.get(node.project.manifestPath);
    if (!state) {
      return [];
    }
    const ancestors = [...node.ancestorKeys, node.key];
    const nodes: DependencyNode[] = [];
    for (const ref of state.graph.children(node.key)) {
      if (!ref.key) {
        continue;
      }
      const child = this.makeNode(node.project, state, ref, false, node.isDev, ancestors);
      if (ancestors.includes(ref.key)) {
        child.circular = true;
        child.hasChildren = false;
      }
      nodes.push(child);
    }
    return nodes.sort((a, b) => a.name.localeCompare(b.name));
  }

  getAllPackages(project: Project): PackageId[] {
    return this.states.get(project.manifestPath)?.graph.allPackages() ?? [];
  }

  locate(project: Project, name: string): { isDirect: boolean; version: string } | undefined {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return undefined;
    }
    const isDirect = [...state.graph.directProd, ...state.graph.directDev].some(
      (r) => r.name === name
    );
    let version: string | undefined;
    for (const key of state.graph.keys()) {
      const entry = state.graph.entry(key);
      if (entry?.name === name) {
        version = entry.version;
        break;
      }
    }
    if (!isDirect && version === undefined) {
      return undefined;
    }
    return { isDirect, version: version ?? '(not installed)' };
  }

  applyVulnerabilities(project: Project): void {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return;
    }
    const graph = state.graph;
    state.vulnClosure = computeVulnClosure(
      graph.keys(),
      (key) => graph.children(key).flatMap((c) => (c.key ? [c.key] : [])),
      (key) => {
        const entry = graph.entry(key);
        return !!entry && this.osv.getVulns('npm', entry.name, entry.version).length > 0;
      }
    );
  }

  private makeNode(
    project: Project,
    state: NpmState,
    ref: DepRef,
    isDirect: boolean,
    isDev: boolean,
    ancestorKeys: string[]
  ): DependencyNode {
    const entry = ref.key ? state.graph.entry(ref.key) : undefined;
    const version = entry?.version ?? '(not installed)';
    const hasChildren = !!ref.key && state.graph.children(ref.key).some((c) => c.key);
    return {
      kind: 'dependency',
      project,
      key: ref.key ?? `missing:${ref.name}`,
      name: ref.name,
      version,
      isDirect,
      isDev,
      hasChildren,
      vulns: entry ? this.osv.getVulns('npm', entry.name, entry.version) : [],
      subtreeVulnerable: ref.key ? state.vulnClosure.has(ref.key) : false,
      ancestorKeys,
    };
  }
}
