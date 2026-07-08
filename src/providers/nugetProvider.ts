import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyNode, DependencyProvider, GraphAccess, PackageId, Project } from '../types';
import { OsvService } from '../services/osvService';
import { computeVulnClosure } from '../services/vulnClosure';

interface NugetLib {
  name: string;
  version: string;
  deps: string[];
  isProject: boolean;
}

interface NugetState {
  tfm: string;
  /** Lowercased package id -> resolved package. NuGet resolves one version per id per framework. */
  libs: Map<string, NugetLib>;
  directNames: string[];
  vulnClosure: Set<string>;
}

export class NugetProvider implements DependencyProvider {
  readonly ecosystem = 'NuGet' as const;
  private states = new Map<string, NugetState>();

  constructor(private osv: OsvService) {}

  async scan(): Promise<Project[]> {
    this.states.clear();
    const projects: Project[] = [];
    const files = await vscode.workspace.findFiles(
      '**/*.{csproj,fsproj,vbproj}',
      '**/{bin,obj,node_modules}/**'
    );

    for (const uri of files) {
      const manifestPath = uri.fsPath;
      const dir = path.dirname(manifestPath);
      const name = path.basename(manifestPath).replace(/\.[^.]+$/, '');
      const project: Project = { ecosystem: 'NuGet', manifestPath, name };
      const assetsPath = path.join(dir, 'obj', 'project.assets.json');

      if (!fs.existsSync(assetsPath)) {
        project.error = 'No obj/project.assets.json found — run "dotnet restore" first.';
        projects.push(project);
        continue;
      }
      try {
        const assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
        const state = this.parseAssets(assets);
        if (!state) {
          project.error = 'Could not find a target framework in project.assets.json.';
        } else {
          this.states.set(manifestPath, state);
        }
      } catch (err) {
        project.error = `Failed to parse project.assets.json: ${err instanceof Error ? err.message : err}`;
      }
      projects.push(project);
    }
    return projects;
  }

  private parseAssets(assets: any): NugetState | undefined {
    const targetKeys = Object.keys(assets.targets ?? {});
    // Prefer the plain TFM target over RID-specific ones like "net8.0/win-x64".
    const tfmKey = targetKeys.find((k) => !k.includes('/')) ?? targetKeys[0];
    if (!tfmKey) {
      return undefined;
    }
    const target = assets.targets[tfmKey] ?? {};
    const libs = new Map<string, NugetLib>();
    for (const [idVersion, info] of Object.entries<any>(target)) {
      const slash = idVersion.indexOf('/');
      if (slash === -1) {
        continue;
      }
      const pkgName = idVersion.slice(0, slash);
      libs.set(pkgName.toLowerCase(), {
        name: pkgName,
        version: idVersion.slice(slash + 1),
        deps: Object.keys(info.dependencies ?? {}),
        isProject: info.type === 'project',
      });
    }

    const tfmBase = tfmKey.split('/')[0];
    let directNames: string[] = [];
    const frameworks = assets.project?.frameworks ?? {};
    const fw = frameworks[tfmBase] ?? frameworks[Object.keys(frameworks)[0]];
    if (fw?.dependencies) {
      directNames = Object.entries<any>(fw.dependencies)
        .filter(([, d]) => !d?.autoReferenced)
        .map(([n]) => n);
    } else {
      const groups = assets.projectFileDependencyGroups ?? {};
      const group: string[] = groups[tfmBase] ?? groups[Object.keys(groups)[0]] ?? [];
      directNames = group.map((entry) => entry.split(' ')[0]);
    }

    return { tfm: tfmBase, libs, directNames, vulnClosure: new Set() };
  }

  getDirectDependencies(project: Project): DependencyNode[] {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return [];
    }
    return state.directNames
      .map((name) => this.makeNode(project, state, name, true, []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getChildDependencies(node: DependencyNode): DependencyNode[] {
    const state = this.states.get(node.project.manifestPath);
    const lib = state?.libs.get(node.key);
    if (!state || !lib) {
      return [];
    }
    const ancestors = [...node.ancestorKeys, node.key];
    const nodes: DependencyNode[] = [];
    for (const depName of lib.deps) {
      const child = this.makeNode(node.project, state, depName, false, ancestors);
      if (ancestors.includes(child.key)) {
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
    return [...state.libs.values()]
      .filter((lib) => !lib.isProject)
      .map((lib) => ({ name: lib.name, version: lib.version }));
  }

  getTargetFramework(project: Project): string | undefined {
    return this.states.get(project.manifestPath)?.tfm;
  }

  locate(project: Project, name: string): { isDirect: boolean; version: string } | undefined {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return undefined;
    }
    const key = name.toLowerCase();
    const lib = state.libs.get(key);
    const isDirect = state.directNames.some((n) => n.toLowerCase() === key);
    if (!lib && !isDirect) {
      return undefined;
    }
    return { isDirect, version: lib?.version ?? '(not resolved)' };
  }

  getGraph(project: Project): GraphAccess | undefined {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return undefined;
    }
    return {
      roots: state.directNames.flatMap((n) =>
        state.libs.has(n.toLowerCase()) ? [{ key: n.toLowerCase(), isDev: false }] : []
      ),
      entry: (key) => {
        const lib = state.libs.get(key);
        return lib ? { name: lib.name, version: lib.version } : undefined;
      },
      childKeys: (key) =>
        (state.libs.get(key)?.deps ?? []).map((d) => d.toLowerCase()).filter((k) => state.libs.has(k)),
      keys: () => [...state.libs.keys()],
    };
  }

  applyVulnerabilities(project: Project): void {
    const state = this.states.get(project.manifestPath);
    if (!state) {
      return;
    }
    state.vulnClosure = computeVulnClosure(
      state.libs.keys(),
      (key) => {
        const lib = state.libs.get(key);
        if (!lib) {
          return [];
        }
        return lib.deps.map((d) => d.toLowerCase()).filter((k) => state.libs.has(k));
      },
      (key) => {
        const lib = state.libs.get(key);
        return !!lib && !lib.isProject && this.osv.getVulns('NuGet', lib.name, lib.version).length > 0;
      }
    );
  }

  private makeNode(
    project: Project,
    state: NugetState,
    name: string,
    isDirect: boolean,
    ancestorKeys: string[]
  ): DependencyNode {
    const key = name.toLowerCase();
    const lib = state.libs.get(key);
    return {
      kind: 'dependency',
      project,
      key,
      name: lib?.name ?? name,
      version: lib?.version ?? '(not resolved)',
      isDirect,
      isDev: false,
      hasChildren: !!lib && lib.deps.some((d) => state.libs.has(d.toLowerCase())),
      vulns: lib && !lib.isProject ? this.osv.getVulns('NuGet', lib.name, lib.version) : [],
      subtreeVulnerable: state.vulnClosure.has(key),
      ancestorKeys,
    };
  }
}
