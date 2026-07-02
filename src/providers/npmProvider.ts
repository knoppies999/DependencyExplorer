import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyNode, DependencyProvider, PackageId, Project } from '../types';
import { OsvService } from '../services/osvService';
import { computeVulnClosure } from '../services/vulnClosure';

interface LockPackage {
  name?: string;
  version?: string;
  dev?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface NpmState {
  /** The "packages" map from package-lock.json v2/v3. Key "" is the root project. */
  packages: Record<string, LockPackage>;
  directProd: string[];
  directDev: string[];
  /** Lockfile keys whose subtree (including the package itself) contains a vulnerability. */
  vulnClosure: Set<string>;
}

export class NpmProvider implements DependencyProvider {
  readonly ecosystem = 'npm' as const;
  private states = new Map<string, NpmState>();

  constructor(private osv: OsvService) {}

  async scan(): Promise<Project[]> {
    this.states.clear();
    const projects: Project[] = [];
    const files = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**');

    for (const uri of files) {
      const manifestPath = uri.fsPath;
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
        continue;
      }
      if (directProd.length === 0 && directDev.length === 0) {
        continue;
      }

      const project: Project = { ecosystem: 'npm', manifestPath, name };
      const lockPath = path.join(dir, 'package-lock.json');
      if (!fs.existsSync(lockPath)) {
        project.error = 'No package-lock.json found — run "npm install" to generate it.';
      } else {
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (!lock.packages) {
            project.error =
              'Lockfile version 1 is not supported — run "npm install" with npm 7+ to upgrade it.';
          } else {
            this.states.set(manifestPath, {
              packages: lock.packages,
              directProd,
              directDev,
              vulnClosure: new Set(),
            });
          }
        } catch (err) {
          project.error = `Failed to parse package-lock.json: ${err instanceof Error ? err.message : err}`;
        }
      }
      projects.push(project);
    }
    return projects;
  }

  getDirectDependencies(project: Project): DependencyNode[] {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return [];
    }
    const nodes: DependencyNode[] = [];
    for (const { names, isDev } of [
      { names: state.directProd, isDev: false },
      { names: state.directDev, isDev: true },
    ]) {
      for (const depName of names) {
        const key = this.resolve(state, '', depName);
        nodes.push(this.makeNode(project, state, depName, key, true, isDev, []));
      }
    }
    return nodes.sort((a, b) => a.name.localeCompare(b.name));
  }

  getChildDependencies(node: DependencyNode): DependencyNode[] {
    const state = this.states.get(node.project.manifestPath);
    const entry = state?.packages[node.key];
    if (!state || !entry) {
      return [];
    }
    const ancestors = [...node.ancestorKeys, node.key];
    const nodes: DependencyNode[] = [];
    for (const depName of this.childNames(entry)) {
      const childKey = this.resolve(state, node.key, depName);
      if (!childKey) {
        continue;
      }
      const child = this.makeNode(node.project, state, depName, childKey, false, node.isDev, ancestors);
      if (ancestors.includes(childKey)) {
        child.circular = true;
        child.hasChildren = false;
      }
      nodes.push(child);
    }
    return nodes.sort((a, b) => a.name.localeCompare(b.name));
  }

  getAllPackages(project: Project): PackageId[] {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return [];
    }
    const result: PackageId[] = [];
    for (const [key, entry] of Object.entries(state.packages)) {
      if (!key || !entry.version || entry.link) {
        continue;
      }
      result.push({ name: entry.name ?? nameFromKey(key), version: entry.version });
    }
    return result;
  }

  locate(project: Project, name: string): { isDirect: boolean; version: string } | undefined {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return undefined;
    }
    const isDirect = state.directProd.includes(name) || state.directDev.includes(name);
    // The same package can be installed at several versions/paths; report the first resolved one.
    let version: string | undefined;
    for (const [key, entry] of Object.entries(state.packages)) {
      if (key && entry.version && !entry.link && (entry.name ?? nameFromKey(key)) === name) {
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
    const keys = Object.keys(state.packages).filter((k) => k);
    state.vulnClosure = computeVulnClosure(
      keys,
      (key) => {
        const entry = state.packages[key];
        if (!entry) {
          return [];
        }
        const children: string[] = [];
        for (const depName of this.childNames(entry)) {
          const childKey = this.resolve(state, key, depName);
          if (childKey) {
            children.push(childKey);
          }
        }
        return children;
      },
      (key) => {
        const entry = state.packages[key];
        if (!entry?.version) {
          return false;
        }
        const name = entry.name ?? nameFromKey(key);
        return this.osv.getVulns('npm', name, entry.version).length > 0;
      }
    );
  }

  private makeNode(
    project: Project,
    state: NpmState,
    name: string,
    key: string | undefined,
    isDirect: boolean,
    isDev: boolean,
    ancestorKeys: string[]
  ): DependencyNode {
    const entry = key ? state.packages[key] : undefined;
    const version = entry?.version ?? '(not installed)';
    const hasChildren =
      !!entry && !!key && this.childNames(entry).some((d) => this.resolve(state, key, d));
    return {
      kind: 'dependency',
      project,
      key: key ?? `missing:${name}`,
      name,
      version,
      isDirect,
      isDev,
      hasChildren,
      vulns: entry?.version ? this.osv.getVulns('npm', name, entry.version) : [],
      subtreeVulnerable: key ? state.vulnClosure.has(key) : false,
      ancestorKeys,
    };
  }

  private childNames(entry: LockPackage): string[] {
    return [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
    ];
  }

  /**
   * Node-style resolution against the lockfile "packages" map: look for the
   * dependency in the requester's own node_modules, then walk up parent scopes.
   */
  private resolve(state: NpmState, fromKey: string, depName: string): string | undefined {
    let scope = fromKey;
    for (;;) {
      const candidate = scope ? `${scope}/node_modules/${depName}` : `node_modules/${depName}`;
      if (state.packages[candidate]) {
        return candidate;
      }
      if (!scope) {
        return undefined;
      }
      const idx = scope.lastIndexOf('/node_modules/');
      scope = idx === -1 ? '' : scope.slice(0, idx);
    }
  }
}

function nameFromKey(key: string): string {
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  return idx === -1 ? key : key.slice(idx + marker.length);
}
