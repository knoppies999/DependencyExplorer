import * as vscode from 'vscode';
import {
  DependencyNode,
  DependencyProvider,
  DuplicatePackage,
  Ecosystem,
  PackageLocation,
  Project,
  TreeNode,
} from '../types';
import { OsvService, packagesToQueries } from '../services/osvService';

export class DependencyTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projects: Project[] = [];
  private scanning: Promise<void> | undefined;

  constructor(
    private providers: DependencyProvider[],
    private osv: OsvService
  ) {}

  refresh(): void {
    this.scanning = this.scan();
    this._onDidChangeTreeData.fire(undefined);
  }

  private async scan(): Promise<void> {
    const all: Project[] = [];
    for (const provider of this.providers) {
      try {
        all.push(...(await provider.scan()));
      } catch (err) {
        console.error(`Dependency Explorer: ${provider.ecosystem} scan failed`, err);
      }
    }
    all.sort((a, b) => a.name.localeCompare(b.name));
    this.projects = all;
    // Vulnerability data arrives asynchronously; the tree refreshes again when it lands.
    void this.scanVulnerabilities();
  }

  private async scanVulnerabilities(): Promise<void> {
    const queries = this.projects.flatMap((project) =>
      packagesToQueries(project.ecosystem, this.providerFor(project).getAllPackages(project))
    );
    if (queries.length === 0) {
      return;
    }
    const gotNewData = await this.osv.query(queries);
    if (gotNewData) {
      for (const project of this.projects) {
        this.providerFor(project).applyVulnerabilities(project);
      }
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private providerFor(project: Project): DependencyProvider {
    const provider = this.providers.find((p) => p.ecosystem === project.ecosystem);
    if (!provider) {
      throw new Error(`No provider for ecosystem ${project.ecosystem}`);
    }
    return provider;
  }

  /** Resolved target framework for a project (NuGet only), used to preview dependency groups. */
  getTargetFramework(project: Project): string | undefined {
    return this.providerFor(project).getTargetFramework?.(project);
  }

  /** Every project of the given ecosystem that contains `name`, with how it's used there. */
  locateAcrossProjects(ecosystem: Ecosystem, name: string): PackageLocation[] {
    const result: PackageLocation[] = [];
    for (const project of this.projects) {
      if (project.ecosystem !== ecosystem || project.error) {
        continue;
      }
      const loc = this.providerFor(project).locate(project, name);
      if (loc) {
        result.push({ project, isDirect: loc.isDirect, version: loc.version });
      }
    }
    return result;
  }

  /** Packages present in two or more projects of the same ecosystem, most-shared first. */
  findDuplicatePackages(): DuplicatePackage[] {
    const index = new Map<string, DuplicatePackage>();
    for (const project of this.projects) {
      if (project.error) {
        continue;
      }
      const provider = this.providerFor(project);
      const seen = new Set<string>();
      for (const pkg of provider.getAllPackages(project)) {
        const nameKey = pkg.name.toLowerCase();
        if (seen.has(nameKey)) {
          continue;
        }
        seen.add(nameKey);
        const indexKey = `${project.ecosystem}::${nameKey}`;
        let entry = index.get(indexKey);
        if (!entry) {
          entry = { ecosystem: project.ecosystem, name: pkg.name, locations: [] };
          index.set(indexKey, entry);
        }
        const loc = provider.locate(project, pkg.name);
        if (loc) {
          entry.locations.push({ project, isDirect: loc.isDirect, version: loc.version });
        }
      }
    }
    return [...index.values()]
      .filter((entry) => entry.locations.length >= 2)
      .sort(
        (a, b) => b.locations.length - a.locations.length || a.name.localeCompare(b.name)
      );
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      await this.scanning;
      return this.projects.map((project) => ({ kind: 'project', project }));
    }
    if (element.kind === 'project') {
      if (element.project.error) {
        return [{ kind: 'message', project: element.project, text: element.project.error }];
      }
      return this.providerFor(element.project).getDirectDependencies(element.project);
    }
    if (element.kind === 'dependency') {
      return this.providerFor(element.project).getChildDependencies(element);
    }
    return [];
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'project') {
      return this.projectItem(element.project);
    }
    if (element.kind === 'message') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    return this.dependencyItem(element);
  }

  private projectItem(project: Project): vscode.TreeItem {
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `project|${project.manifestPath}`;
    item.description = project.ecosystem;
    item.iconPath = new vscode.ThemeIcon(project.ecosystem === 'npm' ? 'json' : 'project');
    item.contextValue = 'project';
    item.tooltip = project.manifestPath;
    item.command = {
      command: 'dependencyExplorer.openManifest',
      title: 'Open Manifest',
      arguments: [{ kind: 'project', project }],
    };
    return item;
  }

  private dependencyItem(node: DependencyNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.hasChildren && !node.circular
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    // Stable unique id (full path from the project root) so expansion state survives refreshes.
    item.id = `${node.project.manifestPath}|${[...node.ancestorKeys, node.key].join('>')}`;

    const flags: string[] = [node.version];
    if (node.isDev) {
      flags.push('dev');
    }
    if (node.circular) {
      flags.push('circular');
    }
    if (node.vulns.length > 0) {
      flags.push(`${node.vulns.length} ${node.vulns.length === 1 ? 'vulnerability' : 'vulnerabilities'}`);
    }
    item.description = flags.join(' · ');

    if (node.vulns.length > 0) {
      item.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.errorForeground')
      );
    } else if (node.subtreeVulnerable) {
      item.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.warningForeground')
      );
    } else {
      item.iconPath = new vscode.ThemeIcon('package');
    }

    item.contextValue = node.isDirect ? 'dep:direct' : 'dep:transitive';
    item.tooltip = this.dependencyTooltip(node);
    return item;
  }

  private dependencyTooltip(node: DependencyNode): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${node.name}** \`${node.version}\`\n\n`);
    md.appendMarkdown(
      `${node.isDirect ? 'Direct' : 'Transitive'} ${node.isDev ? 'dev ' : ''}dependency of **${node.project.name}** (${node.project.ecosystem})\n\n`
    );
    if (node.vulns.length > 0) {
      md.appendMarkdown(`⚠️ **Known vulnerabilities:**\n\n`);
      for (const v of node.vulns) {
        md.appendMarkdown(`- [${v.id}](https://osv.dev/vulnerability/${v.id})\n`);
      }
      md.appendMarkdown('\n');
    } else if (node.subtreeVulnerable) {
      md.appendMarkdown(`⚠️ A transitive dependency in this subtree has known vulnerabilities.\n\n`);
    }
    if (node.circular) {
      md.appendMarkdown(`↩️ Circular reference — already shown further up this branch.\n`);
    }
    return md;
  }
}
