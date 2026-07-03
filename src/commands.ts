import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyNode, Ecosystem, PackageLocation, Project, ProjectNode } from './types';
import { compareVersionsDesc, fetchVersions, isPrerelease } from './services/registryService';
import { FixPlanItem, nearestSafeVersion } from './services/fixPlanner';
import {
  csprojAddPackageReference,
  csprojUpdateVersion,
  detectCpmMode,
  npmAddOverride,
  npmUpdateDependency,
  pnpmAddOverride,
  propsSetPackageVersion,
  propsUpdateVersion,
} from './services/manifestEditor';
import { DependencyTreeProvider } from './tree/dependencyTree';
import { computeBumpPreview } from './services/previewService';
import { confirmBump } from './ui/previewPanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  tree: DependencyTreeProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dependencyExplorer.refresh', () => tree.refresh()),
    vscode.commands.registerCommand(
      'dependencyExplorer.openManifest',
      (node: ProjectNode | DependencyNode) =>
        vscode.window.showTextDocument(vscode.Uri.file(node.project.manifestPath))
    ),
    vscode.commands.registerCommand('dependencyExplorer.updateDependency', (node: DependencyNode) =>
      runFix(tree, node.project.ecosystem, node.name, node.version, node.project)
    ),
    vscode.commands.registerCommand(
      'dependencyExplorer.overrideDependency',
      (node: DependencyNode) =>
        runFix(tree, node.project.ecosystem, node.name, node.version, node.project)
    ),
    vscode.commands.registerCommand('dependencyExplorer.fixAcrossProjects', () =>
      fixAcrossProjects(tree)
    ),
    // Title-bar / palette entry: always offers the all / choose-projects scope picker. Ignores any
    // argument VS Code may pass (e.g. the currently selected node) so it never silently narrows.
    vscode.commands.registerCommand('dependencyExplorer.fixAllVulnerabilities', () =>
      fixAllVulnerabilities(tree)
    ),
    // Project node entry (inline icon / context menu): fixes just that project.
    vscode.commands.registerCommand(
      'dependencyExplorer.fixProjectVulnerabilities',
      (node?: ProjectNode) => fixAllVulnerabilities(tree, node?.project)
    )
  );
}

/**
 * Update/override a package starting from a node the user clicked. If the same
 * package lives in other projects, offer to apply the change to all of them.
 */
async function runFix(
  tree: DependencyTreeProvider,
  ecosystem: Ecosystem,
  name: string,
  currentVersion: string,
  originProject: Project
): Promise<void> {
  const version = await pickVersion(ecosystem, name, currentVersion, dirOf(originProject));
  if (!version) {
    return;
  }

  const locations = tree.locateAcrossProjects(ecosystem, name);
  const isDirect = locations.find((l) => l.project === originProject)?.isDirect ?? true;
  const confirmed = await previewAndConfirm(tree, {
    ecosystem,
    name,
    currentVersion,
    targetVersion: version,
    isDirect,
    project: originProject,
    projectCount: Math.max(locations.length, 1),
  });
  if (!confirmed) {
    return;
  }

  let targets: PackageLocation[];
  if (locations.length > 1) {
    const chosen = await chooseScope(name, locations, originProject);
    if (!chosen) {
      return;
    }
    targets = chosen;
  } else if (locations.length === 1) {
    targets = locations;
  } else {
    // Fallback: the scan couldn't locate it (e.g. lockfile out of date); act on the origin only.
    targets = [{ project: originProject, isDirect: true, version: currentVersion }];
  }

  await applyAndOffer(ecosystem, name, version, targets);
}

/** Entry point from the command palette / view title: pick a shared package, then a version. */
async function fixAcrossProjects(tree: DependencyTreeProvider): Promise<void> {
  const duplicates = tree.findDuplicatePackages();
  if (duplicates.length === 0) {
    vscode.window.showInformationMessage(
      'Dependency Explorer: no package is shared across multiple projects in this workspace.'
    );
    return;
  }

  const items = duplicates.map((dup) => ({
    label: dup.name,
    description: `${dup.ecosystem} · in ${dup.locations.length} projects`,
    detail: dup.locations
      .map((l) => `${l.project.name} (${l.isDirect ? 'direct' : 'transitive'} ${l.version})`)
      .join('   '),
    dup,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Bump a package across every project that uses it',
    placeHolder: 'Select a package shared by multiple projects',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }

  const { ecosystem, name, locations } = picked.dup;
  const currentVersion = mostCommonVersion(locations);
  const version = await pickVersion(ecosystem, name, currentVersion, dirOf(locations[0].project));
  if (!version) {
    return;
  }
  const confirmed = await previewAndConfirm(tree, {
    ecosystem,
    name,
    currentVersion,
    targetVersion: version,
    isDirect: locations.every((l) => l.isDirect),
    project: locations[0].project,
    projectCount: locations.length,
  });
  if (!confirmed) {
    return;
  }
  const targets = await chooseScope(name, locations);
  if (!targets) {
    return;
  }
  await applyAndOffer(ecosystem, name, version, targets);
}

/* --------------------------- fix all vulnerabilities --------------------- */

/** Newer-than-current candidate versions, nearest first, capped to bound OSV queries. */
const FIX_CANDIDATE_CAP = 40;

function candidateVersions(versions: string[], current: string): string[] {
  return versions
    .filter((v) => compareVersionsDesc(v, current) < 0) // strictly newer than current
    .sort((a, b) => compareVersionsDesc(b, a)) // ascending (nearest first)
    .slice(0, FIX_CANDIDATE_CAP);
}

/**
 * Bulk-fix every vulnerable package in a chosen scope by bumping it to the nearest safe version
 * (direct deps updated in place, transitive deps pinned/overridden). Re-runnable: after install +
 * refresh, packages that are no longer vulnerable drop out of the plan.
 */
async function fixAllVulnerabilities(
  tree: DependencyTreeProvider,
  project?: Project
): Promise<void> {
  await tree.ensureVulnerabilities();
  const allProjects = tree.getProjects();
  if (allProjects.length === 0) {
    vscode.window.showInformationMessage('Dependency Explorer: no projects to scan.');
    return;
  }

  const scope = project ? [project] : await chooseFixScope(allProjects);
  if (!scope || scope.length === 0) {
    return;
  }

  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Finding vulnerability fixes…' },
    () => buildFixPlan(tree, scope)
  );
  if (plan.length === 0) {
    vscode.window.showInformationMessage(
      `Dependency Explorer: no known vulnerabilities in ${scope.length === 1 ? scope[0].name : `the ${scope.length} selected projects`}.`
    );
    return;
  }

  const fixable = plan.filter((p) => p.targetVersion);
  const unfixable = plan.filter((p) => !p.targetVersion);
  if (fixable.length === 0) {
    vscode.window.showWarningMessage(
      `Found ${unfixable.length} vulnerable package(s) but no non-vulnerable version is available (${unfixable
        .map((p) => `${p.name}@${p.currentVersion}`)
        .join(', ')}).`
    );
    return;
  }

  const chosen = await confirmFixSelection(fixable, unfixable);
  if (!chosen || chosen.length === 0) {
    return;
  }

  const appliedProjects: Project[] = [];
  const appliedSet = new Set<string>();
  const failures: string[] = [];
  for (const item of chosen) {
    try {
      await applyToProject(item.ecosystem, item.name, item.targetVersion!, {
        project: item.project,
        isDirect: item.isDirect,
        version: item.currentVersion,
      });
      if (!appliedSet.has(item.project.manifestPath)) {
        appliedSet.add(item.project.manifestPath);
        appliedProjects.push(item.project);
      }
    } catch (err) {
      failures.push(`${item.name} in ${item.project.name} (${err instanceof Error ? err.message : err})`);
    }
  }

  if (failures.length > 0) {
    vscode.window.showWarningMessage(`Some fixes could not be applied: ${failures.join('; ')}`);
  }
  if (appliedProjects.length === 0) {
    return;
  }
  const count = chosen.length - failures.length;
  await offerInstall(appliedProjects, `Applied ${count} vulnerability fix${count === 1 ? '' : 'es'}.`);
}

/** All / choose-specific scope selection over projects (single is handled by the node entry point). */
async function chooseFixScope(projects: Project[]): Promise<Project[] | undefined> {
  if (projects.length === 1) {
    return projects;
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: `$(check-all) All ${projects.length} projects`, scope: 'all' as const },
      { label: '$(list-selection) Choose projects…', scope: 'choose' as const },
    ],
    { title: 'Fix all vulnerabilities', placeHolder: 'Which projects should be fixed?' }
  );
  if (!pick) {
    return undefined;
  }
  if (pick.scope === 'all') {
    return projects;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({
      label: p.name,
      description: `${p.ecosystem}${p.packageManager === 'pnpm' ? ' · pnpm' : ''}`,
      detail: p.manifestPath,
      picked: true,
      project: p,
    })),
    {
      title: 'Fix all vulnerabilities — choose projects',
      placeHolder: 'Toggle the projects to fix, then press OK',
      canPickMany: true,
      matchOnDescription: true,
    }
  );
  return picked && picked.length > 0 ? picked.map((p) => p.project) : undefined;
}

/** Build the fix plan: resolve each vulnerable package's nearest safe version (batched OSV query). */
async function buildFixPlan(
  tree: DependencyTreeProvider,
  scope: Project[]
): Promise<FixPlanItem[]> {
  const pending: (FixPlanItem & { versions: string[] })[] = [];
  for (const project of scope) {
    for (const vuln of tree.getVulnerablePackages(project)) {
      let versions: string[] = [];
      try {
        versions = (await fetchVersions(project.ecosystem, vuln.name, dirOf(project))).versions;
      } catch {
        versions = [];
      }
      pending.push({
        project,
        ecosystem: project.ecosystem,
        name: vuln.name,
        isDirect: vuln.isDirect,
        currentVersion: vuln.version,
        versions,
      });
    }
  }

  // Batch OSV safety queries for every candidate version across the whole plan.
  const queries = pending.flatMap((p) =>
    candidateVersions(p.versions, p.currentVersion).map((version) => ({
      ecosystem: p.ecosystem,
      name: p.name,
      version,
    }))
  );
  await tree.loadSafety(queries);

  return pending.map(({ versions, ...item }) => ({
    ...item,
    targetVersion: nearestSafeVersion(
      candidateVersions(versions, item.currentVersion),
      item.currentVersion,
      (version) => tree.isSafeVersion(item.ecosystem, item.name, version),
      compareVersionsDesc,
      isPrerelease
    ),
  }));
}

/** Summary checklist of planned fixes (all pre-checked); returns the items the user kept. */
async function confirmFixSelection(
  fixable: FixPlanItem[],
  unfixable: FixPlanItem[]
): Promise<FixPlanItem[] | undefined> {
  const items = fixable.map((item) => ({
    label: `${item.name}  ${item.currentVersion} → ${item.targetVersion}`,
    description: `${item.project.name} · ${item.isDirect ? 'update' : 'pin'}`,
    picked: true,
    item,
  }));
  const skipped =
    unfixable.length > 0
      ? ` — ${unfixable.length} package(s) with no safe version will be skipped`
      : '';
  const picked = await vscode.window.showQuickPick(items, {
    title: `Apply ${fixable.length} vulnerability fix${fixable.length === 1 ? '' : 'es'}${skipped}`,
    placeHolder: 'Toggle the fixes to apply, then press OK',
    canPickMany: true,
    matchOnDescription: true,
  });
  return picked ? picked.map((p) => p.item) : undefined;
}

interface PreviewRequest {
  ecosystem: Ecosystem;
  name: string;
  currentVersion: string;
  targetVersion: string;
  isDirect: boolean;
  project: Project;
  projectCount: number;
}

/** Fetch the target version's dependency diff and show it for confirmation before applying. */
async function previewAndConfirm(
  tree: DependencyTreeProvider,
  req: PreviewRequest
): Promise<boolean> {
  try {
    const preview = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Analyzing ${req.name}@${req.targetVersion}…`,
      },
      () =>
        computeBumpPreview(
          req.ecosystem,
          req.name,
          req.currentVersion,
          req.targetVersion,
          dirOf(req.project),
          tree.getTargetFramework(req.project)
        )
    );
    return await confirmBump({
      ecosystem: req.ecosystem,
      name: req.name,
      currentVersion: req.currentVersion,
      targetVersion: req.targetVersion,
      isDirect: req.isDirect,
      preview,
      projectCount: req.projectCount,
    });
  } catch (err) {
    // Preview is best-effort; if the registry can't be reached, let the user decide.
    const proceed = await vscode.window.showWarningMessage(
      `Couldn't load a dependency preview for ${req.name}@${req.targetVersion} (${err instanceof Error ? err.message : err}). Apply the change anyway?`,
      { modal: true },
      'Apply anyway'
    );
    return proceed === 'Apply anyway';
  }
}

async function chooseScope(
  name: string,
  locations: PackageLocation[],
  origin?: Project
): Promise<PackageLocation[] | undefined> {
  if (locations.length <= 1) {
    return locations;
  }
  const items: (vscode.QuickPickItem & { scope: 'all' | 'one' | 'choose' })[] = [
    {
      label: `$(check-all) Apply to all ${locations.length} projects`,
      detail: locations
        .map((l) => `${l.project.name} · ${l.isDirect ? 'direct' : 'transitive'} ${l.version}`)
        .join('   '),
      scope: 'all',
    },
  ];

  const originLoc = origin ? locations.find((l) => l.project === origin) : undefined;
  if (origin) {
    const loc = originLoc ?? ({ project: origin, isDirect: false, version: '' } as PackageLocation);
    items.push({
      label: `$(check) Only ${origin.name}`,
      detail: `${loc.isDirect ? 'direct' : 'transitive'} ${loc.version}`,
      scope: 'one',
    });
  }
  items.push({
    label: '$(list-selection) Choose specific projects…',
    detail: 'Pick exactly which projects to update',
    scope: 'choose',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `${name} is used by ${locations.length} projects`,
    placeHolder: 'Where should the change be applied?',
  });
  if (!picked) {
    return undefined;
  }
  if (picked.scope === 'all') {
    return locations;
  }
  if (picked.scope === 'one') {
    return originLoc ? [originLoc] : undefined;
  }
  return selectProjects(name, locations, origin);
}

/** Multi-select checklist of the projects that use `name`, all pre-checked. */
async function selectProjects(
  name: string,
  locations: PackageLocation[],
  origin?: Project
): Promise<PackageLocation[] | undefined> {
  const items = locations.map((l) => ({
    label: l.project.name,
    description: `${l.isDirect ? 'direct' : 'transitive'} ${l.version}${l.project.packageManager === 'pnpm' ? ' · pnpm' : ''}`,
    detail: l.project.manifestPath,
    picked: true,
    loc: l,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `Apply ${name} to which projects?`,
    placeHolder: `Toggle projects, then press OK (originally ${origin?.name ?? 'all'})`,
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked.map((p) => p.loc);
}

async function pickVersion(
  ecosystem: Ecosystem,
  name: string,
  currentVersion: string,
  projectDir: string
): Promise<string | undefined> {
  let versions: string[] = [];
  let latest: string | undefined;
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching versions of ${name}…` },
      () => fetchVersions(ecosystem, name, projectDir)
    );
    versions = result.versions;
    latest = result.latest;
  } catch (err) {
    vscode.window.showWarningMessage(
      `Could not fetch versions for ${name} (${err instanceof Error ? err.message : err}). Enter a version manually.`
    );
  }

  const title = `Set version for ${name} (currently ${currentVersion})`;
  if (versions.length === 0) {
    return vscode.window.showInputBox({ title, prompt: `Version for ${name}`, value: currentVersion });
  }

  const items: vscode.QuickPickItem[] = versions.slice(0, 100).map((v) => ({
    label: v,
    description: [
      v === latest ? 'latest' : undefined,
      v === currentVersion ? 'current' : undefined,
      isPrerelease(v) ? 'pre-release' : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  items.push({ label: '$(edit) Enter version manually…', alwaysShow: true });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Select the version to use',
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.label.startsWith('$(edit)')) {
    return vscode.window.showInputBox({ title, prompt: `Version for ${name}` });
  }
  return picked.label;
}

/** Apply the version to every target (direct → update, transitive → override/pin), then offer install. */
async function applyAndOffer(
  ecosystem: Ecosystem,
  name: string,
  version: string,
  targets: PackageLocation[]
): Promise<void> {
  const applied: Project[] = [];
  const failures: string[] = [];
  for (const target of targets) {
    try {
      await applyToProject(ecosystem, name, version, target);
      applied.push(target.project);
    } catch (err) {
      failures.push(`${target.project.name} (${err instanceof Error ? err.message : err})`);
    }
  }

  if (failures.length > 0) {
    vscode.window.showWarningMessage(
      `Could not set ${name} to ${version} in: ${failures.join('; ')}`
    );
  }
  if (applied.length === 0) {
    return;
  }

  const where =
    applied.length === 1
      ? path.basename(applied[0].manifestPath)
      : `${applied.length} projects`;
  await offerInstall(applied, `${name} set to ${version} in ${where}.`);
}

async function applyToProject(
  ecosystem: Ecosystem,
  name: string,
  version: string,
  target: PackageLocation
): Promise<void> {
  if (target.isDirect) {
    if (ecosystem === 'npm') {
      await updateNpmDirect(target.project, name, version);
    } else {
      await updateNugetDirect(target.project, name, version);
    }
  } else if (ecosystem === 'npm') {
    if (target.project.packageManager === 'pnpm') {
      await overridePnpm(target.project, name, version);
    } else {
      await overrideNpm(target.project, name, version);
    }
  } else {
    await overrideNuget(target.project, name, version);
  }
}

/* ---------------------------------- npm ---------------------------------- */

async function updateNpmDirect(project: Project, name: string, version: string): Promise<void> {
  const p = project.manifestPath;
  await writeFileWithUndo(p, npmUpdateDependency(fs.readFileSync(p, 'utf8'), name, version));
}

async function overrideNpm(project: Project, name: string, version: string): Promise<void> {
  const p = project.manifestPath;
  await writeFileWithUndo(p, npmAddOverride(fs.readFileSync(p, 'utf8'), name, version));
}

/** pnpm overrides live in the workspace-root package.json under "pnpm.overrides". */
async function overridePnpm(project: Project, name: string, version: string): Promise<void> {
  const rootDir = project.workspaceRoot ?? path.dirname(project.manifestPath);
  const p = path.join(rootDir, 'package.json');
  await writeFileWithUndo(p, pnpmAddOverride(fs.readFileSync(p, 'utf8'), name, version));
}

/* --------------------------------- NuGet --------------------------------- */

async function updateNugetDirect(project: Project, name: string, version: string): Promise<void> {
  const projPath = project.manifestPath;
  const updatedProj = csprojUpdateVersion(fs.readFileSync(projPath, 'utf8'), name, version);
  if (updatedProj !== undefined) {
    await writeFileWithUndo(projPath, updatedProj);
    return;
  }

  // Central Package Management: the version lives in Directory.Packages.props.
  const propsPath = findPackagesProps(path.dirname(projPath));
  if (propsPath) {
    const updatedProps = propsUpdateVersion(fs.readFileSync(propsPath, 'utf8'), name, version);
    if (updatedProps !== undefined) {
      await writeFileWithUndo(propsPath, updatedProps);
      return;
    }
  }

  throw new Error(
    `no versioned PackageReference in ${path.basename(projPath)}${propsPath ? ' or Directory.Packages.props' : ''}`
  );
}

async function overrideNuget(project: Project, name: string, version: string): Promise<void> {
  const projPath = project.manifestPath;
  const projText = fs.readFileSync(projPath, 'utf8');
  const propsPath = findPackagesProps(path.dirname(projPath));
  const propsText = propsPath ? fs.readFileSync(propsPath, 'utf8') : '';
  const cpm = detectCpmMode(propsText, projText);

  if (cpm.enabled && propsPath) {
    // Central Package Management: the pinned version goes in Directory.Packages.props.
    await writeFileWithUndo(propsPath, propsSetPackageVersion(propsText, name, version));
    // With transitive pinning enabled, that PackageVersion alone pins the transitive package.
    // Otherwise a PackageVersion only takes effect for *referenced* packages, so promote it to
    // a direct (versionless) PackageReference to force the override.
    if (!cpm.transitivePinning) {
      await writeFileWithUndo(projPath, csprojAddPackageReference(projText, name));
    }
    return;
  }

  await writeFileWithUndo(projPath, csprojAddPackageReference(projText, name, version));
}

/** Walk up from `startDir` looking for Directory.Packages.props (stops at drive root). */
function findPackagesProps(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'Directory.Packages.props');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/* --------------------------------- shared -------------------------------- */

async function writeFileWithUndo(filePath: string, newText: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(filePath);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    newText
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`could not apply edit to ${filePath}`);
  }
  await doc.save();
}

/** Install command for a project: pnpm/npm for the npm ecosystem, dotnet restore for NuGet. */
function installCommandFor(project: Project): string {
  if (project.ecosystem === 'NuGet') {
    return 'dotnet restore';
  }
  return project.packageManager === 'pnpm' ? 'pnpm install' : 'npm install';
}

/** Directory to run the install in (pnpm installs the whole workspace from its root). */
function installDirFor(project: Project): string {
  if (project.packageManager === 'pnpm') {
    return project.workspaceRoot ?? path.dirname(project.manifestPath);
  }
  return path.dirname(project.manifestPath);
}

async function offerInstall(projects: Project[], message: string): Promise<void> {
  // Group dirs by install command — a fix can touch npm, pnpm and NuGet projects at once.
  const byCommand = new Map<string, Set<string>>();
  for (const project of projects) {
    const cmd = installCommandFor(project);
    if (!byCommand.has(cmd)) {
      byCommand.set(cmd, new Set());
    }
    byCommand.get(cmd)!.add(installDirFor(project));
  }

  const commands = [...byCommand.keys()];
  const action = await vscode.window.showInformationMessage(
    `${message} Run ${commands.map((c) => `"${c}"`).join(' / ')} to apply it — the tree refreshes automatically afterwards.`,
    commands.length === 1 ? `Run ${commands[0]}` : 'Run install commands'
  );
  if (!action) {
    return;
  }
  for (const [cmd, dirs] of byCommand) {
    for (const dir of dirs) {
      const terminal = vscode.window.createTerminal({ name: `${cmd} · ${path.basename(dir)}`, cwd: dir });
      terminal.show();
      terminal.sendText(cmd);
    }
  }
}

/** Directory that holds a project's manifest — the base for resolving its `.npmrc` / `NuGet.config`. */
function dirOf(project: Project): string {
  return path.dirname(project.manifestPath);
}

function mostCommonVersion(locations: PackageLocation[]): string {
  const counts = new Map<string, number>();
  for (const loc of locations) {
    counts.set(loc.version, (counts.get(loc.version) ?? 0) + 1);
  }
  let best = locations[0]?.version ?? '';
  let bestCount = 0;
  for (const [version, count] of counts) {
    if (count > bestCount) {
      best = version;
      bestCount = count;
    }
  }
  return best;
}
