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
import { compareVersionsDesc } from '../services/registryService';
import { matchesAnyPattern } from '../services/packageMatch';

export class DependencyTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projects: Project[] = [];
  private scanning: Promise<void> | undefined;
  private vulnScanning: Promise<void> | undefined;

  constructor(
    private providers: DependencyProvider[],
    private osv: OsvService
  ) {}

  refresh(): void {
    this.scanning = this.scan();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Re-render tree items without re-scanning — e.g. after a settings toggle changes a contextValue. */
  rerender(): void {
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
    this.vulnScanning = this.scanVulnerabilities();
    void this.vulnScanning;
  }

  /** Projects the tree can act on (excludes those that failed to parse). */
  getProjects(): Project[] {
    return this.projects.filter((p) => !p.error);
  }

  /**
   * Every scanned project, including ones that failed to parse — used by re-install, since an
   * unrestored NuGet project (no project.assets.json) is exactly what a re-install should fix.
   */
  getAllProjects(): Project[] {
    return this.projects;
  }

  /** Ensure a scan has run (manifests parsed) — used by flows that don't need OSV data. */
  async ensureScanned(): Promise<void> {
    if (!this.scanning) {
      this.refresh();
    }
    await this.scanning;
  }

  /** Ensure a scan has run and OSV vulnerability data has loaded (for bulk fix). */
  async ensureVulnerabilities(): Promise<void> {
    await this.ensureScanned();
    await this.vulnScanning;
  }

  /**
   * Distinct packages in a project, one entry per name (the newest resolved version is the bump
   * baseline), with whether the package is a direct dependency. `keep` filters which packages to
   * include; pass `() => true` for every package.
   */
  private collectDistinct(
    project: Project,
    keep: (name: string, version: string) => boolean
  ): { name: string; version: string; isDirect: boolean }[] {
    if (project.error) {
      return [];
    }
    const provider = this.providerFor(project);
    const highest = new Map<string, string>();
    for (const pkg of provider.getAllPackages(project)) {
      if (!keep(pkg.name, pkg.version)) {
        continue;
      }
      const cur = highest.get(pkg.name);
      // compareVersionsDesc(a, b) < 0 ⇒ a is newer than b; keep the newest resolved version.
      if (cur === undefined || compareVersionsDesc(pkg.version, cur) < 0) {
        highest.set(pkg.name, pkg.version);
      }
    }
    return [...highest].map(([name, version]) => ({
      name,
      version,
      isDirect: provider.locate(project, name)?.isDirect ?? false,
    }));
  }

  /**
   * Distinct vulnerable packages in a project, one entry per name (the highest vulnerable version
   * seen is the bump baseline), with whether the package is a direct dependency.
   */
  getVulnerablePackages(project: Project): { name: string; version: string; isDirect: boolean }[] {
    return this.collectDistinct(
      project,
      (name, version) => this.osv.getVulns(project.ecosystem, name, version).length > 0
    );
  }

  /** Every distinct package in a project (for "update all to latest"), newest version per name. */
  getAllDistinctPackages(project: Project): { name: string; version: string; isDirect: boolean }[] {
    return this.collectDistinct(project, () => true);
  }

  /** Distinct vulnerable packages and total advisories in a project (for the project-node badge). */
  getProjectVulnerabilitySummary(project: Project): { packages: number; advisories: number } {
    if (project.error) {
      return { packages: 0, advisories: 0 };
    }
    const provider = this.providerFor(project);
    const seen = new Set<string>();
    let packages = 0;
    let advisories = 0;
    for (const pkg of provider.getAllPackages(project)) {
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const vulns = this.osv.getVulns(project.ecosystem, pkg.name, pkg.version);
      if (vulns.length > 0) {
        packages++;
        advisories += vulns.length;
      }
    }
    return { packages, advisories };
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

  /** Batch-query OSV for arbitrary (ecosystem, name, version) triples (used to find safe versions). */
  async loadSafety(
    queries: { ecosystem: Ecosystem; name: string; version: string }[]
  ): Promise<void> {
    if (queries.length > 0) {
      await this.osv.query(queries);
    }
  }

  /** Whether a specific version has no known vulnerabilities (must be loaded via loadSafety first). */
  isSafeVersion(ecosystem: Ecosystem, name: string, version: string): boolean {
    return this.osv.getVulns(ecosystem, name, version).length === 0;
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
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `project|${project.manifestPath}`;

    // Vulnerability badge shows to the right of the project name (first in the description).
    const summary = this.getProjectVulnerabilitySummary(project);
    const description: string[] = [];
    if (summary.packages > 0) {
      description.push(`⚠ ${summary.packages} vulnerable`);
    }
    description.push(project.ecosystem);
    item.description = description.join(' · ');

    // Keep the ecosystem icon on the left; the badge on the right conveys vulnerability.
    item.iconPath = new vscode.ThemeIcon(project.ecosystem === 'npm' ? 'json' : 'project');

    item.contextValue = 'project';
    item.tooltip = this.projectTooltip(project, summary);
    item.command = {
      command: 'dependencyExplorer.openManifest',
      title: 'Open Manifest',
      arguments: [{ kind: 'project', project }],
    };
    return item;
  }

  private projectTooltip(
    project: Project,
    summary: { packages: number; advisories: number }
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const pm = project.packageManager === 'pnpm' ? ' · pnpm' : '';
    md.appendMarkdown(`**${project.name}** (${project.ecosystem}${pm})\n\n`);
    md.appendMarkdown(`${project.manifestPath}\n\n`);
    if (summary.packages > 0) {
      const pkgs = `${summary.packages} vulnerable package${summary.packages === 1 ? '' : 's'}`;
      const adv = `${summary.advisories} advisor${summary.advisories === 1 ? 'y' : 'ies'}`;
      md.appendMarkdown(`⚠️ **${pkgs}** (${adv}). Use **Fix All Vulnerabilities** to bump them.\n`);
    }
    return md;
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

    // contextValue drives the right-click menu. Append the list-membership flags so the menu can
    // show a "Prefer Latest / Never Update" add option or its "Remove from …" counterpart. Matched
    // by regex in package.json, so the base `dep:direct` / `dep:transitive` prefix is preserved.
    const ctx = [node.isDirect ? 'dep:direct' : 'dep:transitive'];
    const config = vscode.workspace.getConfiguration('dependencyExplorer');
    if (matchesAnyPattern(node.name, config.get<string[]>('alwaysLatestPackages', []))) {
      ctx.push('preferLatest');
    }
    if (matchesAnyPattern(node.name, config.get<string[]>('neverUpdatePackages', []))) {
      ctx.push('neverUpdate');
    }
    item.contextValue = ctx.join('.');
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
