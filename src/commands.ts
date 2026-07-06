import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { isPeerConflict, peerDepsRetryFlag } from './services/installRetry';
import { DependencyNode, Ecosystem, PackageLocation, Project, ProjectNode } from './types';
import { compareVersionsDesc, fetchVersions, isPrerelease } from './services/registryService';
import { FixPlanItem, nearestSafeVersion } from './services/fixPlanner';
import { matchesAnyPattern } from './services/packageMatch';
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
    ),
    // Title-bar / palette entry: bumps every package (not just vulnerable ones) to its latest
    // published version. Ignores any argument so it always offers the scope picker.
    vscode.commands.registerCommand('dependencyExplorer.updateAllToLatest', () =>
      updateAllToLatest(tree)
    ),
    // Project node entry: update every package in just that project to its latest version.
    vscode.commands.registerCommand(
      'dependencyExplorer.updateProjectToLatest',
      (node?: ProjectNode) => updateAllToLatest(tree, node?.project)
    ),
    // Dependency node context menu: toggle the package on the "prefer latest" list.
    vscode.commands.registerCommand(
      'dependencyExplorer.addToAlwaysLatest',
      (node: DependencyNode) => addToAlwaysLatest(tree, node.name)
    ),
    vscode.commands.registerCommand(
      'dependencyExplorer.removeFromAlwaysLatest',
      (node: DependencyNode) => removeFromFlagList(tree, 'alwaysLatestPackages', node.name, 'prefer-latest')
    ),
    // Dependency node context menu: toggle the package on the "never update" list.
    vscode.commands.registerCommand(
      'dependencyExplorer.addToNeverUpdate',
      (node: DependencyNode) => addToNeverUpdate(tree, node.name)
    ),
    vscode.commands.registerCommand(
      'dependencyExplorer.removeFromNeverUpdate',
      (node: DependencyNode) => removeFromFlagList(tree, 'neverUpdatePackages', node.name, 'never-update')
    ),
    // Project node context menu: re-install just that project's dependencies.
    vscode.commands.registerCommand('dependencyExplorer.reinstallProject', (node?: ProjectNode) =>
      reinstallDependencies(tree, node ? [node.project] : tree.getAllProjects())
    ),
    // Title-bar / palette entry: re-install dependencies for every open project.
    vscode.commands.registerCommand('dependencyExplorer.reinstallAll', async () => {
      await tree.ensureScanned();
      const projects = tree.getAllProjects();
      if (projects.length === 0) {
        vscode.window.showInformationMessage('Dependency Explorer: no projects to re-install.');
        return;
      }
      if (projects.length > 1) {
        const ok = await vscode.window.showWarningMessage(
          `Re-install dependencies for all ${projects.length} projects?`,
          { modal: true },
          'Re-install All'
        );
        if (ok !== 'Re-install All') {
          return;
        }
      }
      await reinstallDependencies(tree, projects);
    })
  );
}

/** Packages the user has flagged to always jump to the latest version on any upgrade (settings). */
function alwaysLatestPatterns(): string[] {
  return vscode.workspace
    .getConfiguration('dependencyExplorer')
    .get<string[]>('alwaysLatestPackages', []);
}

/** Packages the user has flagged to hold back from both bulk operations (settings). */
function neverUpdatePatterns(): string[] {
  return vscode.workspace
    .getConfiguration('dependencyExplorer')
    .get<string[]>('neverUpdatePackages', []);
}

/** True if `name` is on the never-update list. */
function isNeverUpdate(name: string): boolean {
  return matchesAnyPattern(name, neverUpdatePatterns());
}

/**
 * Guard a manual, user-initiated version change: never-update only *automatically* holds packages
 * back in bulk, but an explicit update should still confirm before overriding that intent.
 */
async function confirmManualUpdate(name: string): Promise<boolean> {
  if (!isNeverUpdate(name)) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    `${name} is on your never-update list. Update it anyway?`,
    { modal: true },
    'Update Anyway'
  );
  return choice === 'Update Anyway';
}

/** Let the user know which packages a bulk run left untouched because of the never-update list. */
function reportHeld(held: string[]): void {
  if (held.length === 0) {
    return;
  }
  vscode.window.showInformationMessage(
    `Held back ${held.length} package${held.length === 1 ? '' : 's'} on your never-update list: ${held.join(', ')}.`
  );
}

/** Where flag-list edits are written: the workspace when one is open, otherwise the user profile. */
function flagConfigTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

/** Add a package name to the `alwaysLatestPackages` setting, then refresh so the menu toggles. */
async function addToAlwaysLatest(tree: DependencyTreeProvider, name: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('dependencyExplorer');
  const current = config.get<string[]>('alwaysLatestPackages', []);
  if (matchesAnyPattern(name, current)) {
    vscode.window.showInformationMessage(`${name} is already set to prefer the latest version.`);
    return;
  }
  await config.update(
    'alwaysLatestPackages',
    [...current, name].sort((a, b) => a.localeCompare(b)),
    flagConfigTarget()
  );
  tree.rerender();
  vscode.window.showInformationMessage(
    `${name} will now prefer its latest version during bulk updates (falling back to the nearest safe version if latest is vulnerable).`
  );
}

/** Add a package name to the `neverUpdatePackages` setting, then refresh so the menu toggles. */
async function addToNeverUpdate(tree: DependencyTreeProvider, name: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('dependencyExplorer');
  const current = config.get<string[]>('neverUpdatePackages', []);
  if (matchesAnyPattern(name, current)) {
    vscode.window.showInformationMessage(`${name} is already set to never update.`);
    return;
  }
  await config.update(
    'neverUpdatePackages',
    [...current, name].sort((a, b) => a.localeCompare(b)),
    flagConfigTarget()
  );
  tree.rerender();
  const alsoPreferLatest = matchesAnyPattern(name, alwaysLatestPatterns())
    ? ' (it’s also on your prefer-latest list — never-update takes precedence in bulk operations)'
    : '';
  vscode.window.showInformationMessage(
    `${name} will now be held back from Fix All Vulnerabilities and Update All to Latest${alsoPreferLatest}.`
  );
}

/**
 * Remove a package from one of the flag lists (the toggle's "off" side). Deletes exact,
 * case-insensitive entries from whichever settings scope defines them. If the package is still
 * matched by a remaining `*` wildcard, we say so rather than silently deleting a broad pattern.
 */
async function removeFromFlagList(
  tree: DependencyTreeProvider,
  key: 'alwaysLatestPackages' | 'neverUpdatePackages',
  name: string,
  label: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('dependencyExplorer');
  const lower = name.toLowerCase();
  const inspect = config.inspect<string[]>(key);
  const scopes: [string[] | undefined, vscode.ConfigurationTarget][] = [
    [inspect?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    [inspect?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspect?.globalValue, vscode.ConfigurationTarget.Global],
  ];
  let removed = false;
  for (const [value, target] of scopes) {
    if (value?.some((p) => p.trim().toLowerCase() === lower)) {
      await config.update(key, value.filter((p) => p.trim().toLowerCase() !== lower), target);
      removed = true;
    }
  }
  if (removed) {
    tree.rerender();
  }

  const remaining = vscode.workspace.getConfiguration('dependencyExplorer').get<string[]>(key, []);
  const wildcards = remaining.filter((p) => p.includes('*') && matchesAnyPattern(name, [p]));
  if (wildcards.length > 0) {
    vscode.window.showWarningMessage(
      `${name} is still on the ${label} list via wildcard ${wildcards.length === 1 ? 'pattern' : 'patterns'} ` +
        `${wildcards.map((p) => `"${p}"`).join(', ')} — edit the setting to change that.`
    );
  } else if (removed) {
    vscode.window.showInformationMessage(`${name} removed from the ${label} list.`);
  } else {
    vscode.window.showInformationMessage(`${name} was not on the ${label} list.`);
  }
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
  if (!(await confirmManualUpdate(name))) {
    return;
  }
  const choice = await pickVersion(ecosystem, name, currentVersion, dirOf(originProject));
  if (!choice) {
    return;
  }

  const locations = tree.locateAcrossProjects(ecosystem, name);
  const isDirect = locations.find((l) => l.project === originProject)?.isDirect ?? true;
  const confirmed = await previewAndConfirm(tree, {
    ecosystem,
    name,
    currentVersion,
    targetVersion: choice.spec,
    resolvedVersion: choice.concrete,
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

  await applyAndOffer(ecosystem, name, choice.spec, targets);
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
  if (!(await confirmManualUpdate(name))) {
    return;
  }
  const currentVersion = mostCommonVersion(locations);
  const choice = await pickVersion(ecosystem, name, currentVersion, dirOf(locations[0].project));
  if (!choice) {
    return;
  }
  const confirmed = await previewAndConfirm(tree, {
    ecosystem,
    name,
    currentVersion,
    targetVersion: choice.spec,
    resolvedVersion: choice.concrete,
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
  await applyAndOffer(ecosystem, name, choice.spec, targets);
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

  const scope = project ? [project] : await chooseProjectScope(allProjects, 'Fix all vulnerabilities');
  if (!scope || scope.length === 0) {
    return;
  }

  const { items, unresolved, held } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Finding vulnerability fixes…' },
    () => buildFixPlan(tree, scope)
  );
  if (items.length === 0 && unresolved.length === 0 && held.length === 0) {
    vscode.window.showInformationMessage(
      `Dependency Explorer: no known vulnerabilities in ${scopeLabel(scope)}.`
    );
    return;
  }

  reportHeld(held);
  const manual = await promptManualVersions(unresolved);
  const fixable = [...items.filter((p) => p.targetVersion), ...manual];
  const unfixable = items.filter((p) => !p.targetVersion);
  if (fixable.length === 0) {
    if (unfixable.length > 0) {
      vscode.window.showWarningMessage(
        `Found ${unfixable.length} vulnerable package(s) but no non-vulnerable version is available (${unfixable
          .map((p) => `${p.name}@${p.currentVersion}`)
          .join(', ')}).`
      );
    }
    return;
  }

  const skippedSuffix =
    unfixable.length > 0
      ? ` — ${unfixable.length} package(s) with no safe version will be skipped`
      : '';
  const chosen = await confirmSelection(
    fixable,
    `Apply ${fixable.length} vulnerability fix${fixable.length === 1 ? '' : 'es'}${skippedSuffix}`
  );
  if (!chosen || chosen.length === 0) {
    return;
  }

  await applyPlan(chosen, (count) => `Applied ${count} vulnerability fix${count === 1 ? '' : 'es'}.`);
}

/**
 * Bulk-update every package (not just vulnerable ones) in a chosen scope to its latest published
 * version — direct deps updated in place, transitive deps pinned. Packages already at the latest
 * version are skipped.
 */
async function updateAllToLatest(tree: DependencyTreeProvider, project?: Project): Promise<void> {
  await tree.ensureScanned();
  const allProjects = tree.getProjects();
  if (allProjects.length === 0) {
    vscode.window.showInformationMessage('Dependency Explorer: no projects to scan.');
    return;
  }

  const scope = project
    ? [project]
    : await chooseProjectScope(allProjects, 'Update all packages to latest');
  if (!scope || scope.length === 0) {
    return;
  }

  const { items, unresolved, held } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Finding latest versions…' },
    () => buildUpdatePlan(tree, scope)
  );
  if (items.length === 0 && unresolved.length === 0 && held.length === 0) {
    vscode.window.showInformationMessage(
      `Dependency Explorer: every package in ${scopeLabel(scope)} is already at its latest version.`
    );
    return;
  }

  reportHeld(held);
  const manual = await promptManualVersions(unresolved);
  const plan = [...items, ...manual];
  if (plan.length === 0) {
    vscode.window.showInformationMessage(
      `Dependency Explorer: nothing to update in ${scopeLabel(scope)}.`
    );
    return;
  }

  const alwaysLatest = alwaysLatestPatterns();
  const isFlagged = (item: FixPlanItem) => matchesAnyPattern(item.name, alwaysLatest);
  const chosen = await confirmSelection(
    plan,
    `Update ${plan.length} package${plan.length === 1 ? '' : 's'} to latest`,
    // Directs and prefer-latest packages start checked; other transitive pins are opt-in.
    (item) => item.isDirect || isFlagged(item),
    (item) => (isFlagged(item) ? '★ prefer-latest' : undefined)
  );
  if (!chosen || chosen.length === 0) {
    return;
  }

  await applyPlan(chosen, (count) => `Updated ${count} package${count === 1 ? '' : 's'} to latest.`);
}

/** Human-readable label for a chosen scope (single project name, or "the N selected projects"). */
function scopeLabel(scope: Project[]): string {
  return scope.length === 1 ? scope[0].name : `the ${scope.length} selected projects`;
}

/** Apply each planned change (direct → update, transitive → pin), then offer to install. */
async function applyPlan(
  chosen: FixPlanItem[],
  successMessage: (count: number) => string
): Promise<void> {
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
    vscode.window.showWarningMessage(`Some changes could not be applied: ${failures.join('; ')}`);
  }
  if (appliedProjects.length === 0) {
    return;
  }
  const count = chosen.length - failures.length;
  await offerInstall(appliedProjects, successMessage(count));
}

/** All / choose-specific scope selection over projects (single is handled by the node entry point). */
async function chooseProjectScope(
  projects: Project[],
  title: string
): Promise<Project[] | undefined> {
  if (projects.length === 1) {
    return projects;
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: `$(check-all) All ${projects.length} projects`, scope: 'all' as const },
      { label: '$(list-selection) Choose projects…', scope: 'choose' as const },
    ],
    { title, placeHolder: 'Which projects should be updated?' }
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
      title: `${title} — choose projects`,
      placeHolder: 'Toggle the projects, then press OK',
      canPickMany: true,
      matchOnDescription: true,
    }
  );
  return picked && picked.length > 0 ? picked.map((p) => p.project) : undefined;
}

/** A package whose available versions couldn't be resolved (feed unreachable, or timed out). */
type UnresolvedPackage = Omit<FixPlanItem, 'targetVersion'>;

/**
 * Tell the user which packages couldn't be resolved and let them supply versions by hand (or leave
 * them out). Returns the packages they gave a version for, as ready-to-apply plan items; packages
 * left blank (or the same as the current version) are skipped.
 */
async function promptManualVersions(unresolved: UnresolvedPackage[]): Promise<FixPlanItem[]> {
  if (unresolved.length === 0) {
    return [];
  }
  const names = unresolved.map((u) => `${u.name} (${u.project.name})`).join(', ');
  const choice = await vscode.window.showWarningMessage(
    `Couldn't resolve versions for ${unresolved.length} package${unresolved.length === 1 ? '' : 's'}: ` +
      `${names}. They were skipped — you can enter versions for them manually.`,
    'Enter Versions Manually'
  );
  if (choice !== 'Enter Versions Manually') {
    return [];
  }

  const resolved: FixPlanItem[] = [];
  for (const pkg of unresolved) {
    const version = await vscode.window.showInputBox({
      title: `Set version for ${pkg.name} (${pkg.project.name})`,
      prompt: `Version to apply for ${pkg.name} (currently ${pkg.currentVersion}). Leave blank to skip.`,
      value: pkg.currentVersion,
      ignoreFocusOut: true,
    });
    const trimmed = version?.trim();
    if (trimmed && trimmed !== pkg.currentVersion) {
      resolved.push({ ...pkg, targetVersion: trimmed });
    }
  }
  return resolved;
}

/**
 * Build the fix plan: resolve each vulnerable package's nearest safe version (batched OSV query).
 * Packages the user has flagged as "prefer latest" jump straight to the latest published version
 * instead, as long as that version is itself safe (otherwise they fall back to nearest-safe).
 * Packages whose versions couldn't be resolved are returned separately as `unresolved`.
 */
async function buildFixPlan(
  tree: DependencyTreeProvider,
  scope: Project[]
): Promise<{ items: FixPlanItem[]; unresolved: UnresolvedPackage[]; held: string[] }> {
  const alwaysLatest = alwaysLatestPatterns();
  const pending: (FixPlanItem & { versions: string[]; latest?: string; wantLatest: boolean })[] = [];
  const unresolved: UnresolvedPackage[] = [];
  const held = new Set<string>();
  for (const project of scope) {
    for (const vuln of tree.getVulnerablePackages(project)) {
      if (isNeverUpdate(vuln.name)) {
        // On the never-update list: leave it untouched even though it's vulnerable.
        held.add(vuln.name);
        continue;
      }
      let versions: string[];
      let latest: string | undefined;
      try {
        const result = await fetchVersions(project.ecosystem, vuln.name, dirOf(project));
        versions = result.versions;
        latest = result.latest;
      } catch {
        // Couldn't reach the feed (or timed out) — record it so the user can decide, rather than
        // conflating it with "resolved, but no safe version exists".
        unresolved.push({
          project,
          ecosystem: project.ecosystem,
          name: vuln.name,
          isDirect: vuln.isDirect,
          currentVersion: vuln.version,
        });
        continue;
      }
      pending.push({
        project,
        ecosystem: project.ecosystem,
        name: vuln.name,
        isDirect: vuln.isDirect,
        currentVersion: vuln.version,
        versions,
        latest,
        wantLatest: matchesAnyPattern(vuln.name, alwaysLatest),
      });
    }
  }

  // Batch OSV safety queries for every candidate version across the whole plan, plus the latest
  // version of any prefer-latest package (so we can confirm it's safe before targeting it).
  const queries = pending.flatMap((p) => {
    const candidates = candidateVersions(p.versions, p.currentVersion);
    if (p.wantLatest && p.latest && !candidates.includes(p.latest)) {
      candidates.push(p.latest);
    }
    return candidates.map((version) => ({ ecosystem: p.ecosystem, name: p.name, version }));
  });
  await tree.loadSafety(queries);

  const items = pending.map(({ versions, latest, wantLatest, ...item }) => {
    // Prefer-latest packages go to the latest version when it's newer and known-safe.
    if (
      wantLatest &&
      latest &&
      compareVersionsDesc(latest, item.currentVersion) < 0 &&
      tree.isSafeVersion(item.ecosystem, item.name, latest)
    ) {
      return { ...item, targetVersion: latest };
    }
    return {
      ...item,
      targetVersion: nearestSafeVersion(
        candidateVersions(versions, item.currentVersion),
        item.currentVersion,
        (version) => tree.isSafeVersion(item.ecosystem, item.name, version),
        compareVersionsDesc,
        isPrerelease
      ),
    };
  });
  return { items, unresolved, held: [...held].sort((a, b) => a.localeCompare(b)) };
}

/**
 * Build the update plan: for every distinct package in scope, target its latest published version.
 * Packages already at (or ahead of) the latest version are dropped, so the plan only holds real
 * updates. No OSV query needed — this is a straight bump, not a vulnerability fix.
 */
async function buildUpdatePlan(
  tree: DependencyTreeProvider,
  scope: Project[]
): Promise<{ items: FixPlanItem[]; unresolved: UnresolvedPackage[]; held: string[] }> {
  const items: FixPlanItem[] = [];
  const unresolved: UnresolvedPackage[] = [];
  const held = new Set<string>();
  for (const project of scope) {
    for (const pkg of tree.getAllDistinctPackages(project)) {
      if (isNeverUpdate(pkg.name)) {
        held.add(pkg.name);
        continue;
      }
      let latest: string | undefined;
      try {
        latest = (await fetchVersions(project.ecosystem, pkg.name, dirOf(project))).latest;
      } catch {
        // Feed unreachable or timed out — surface it instead of silently dropping the package.
        unresolved.push({
          project,
          ecosystem: project.ecosystem,
          name: pkg.name,
          isDirect: pkg.isDirect,
          currentVersion: pkg.version,
        });
        continue;
      }
      // Only include a package when the registry offers a strictly newer version to move to.
      if (!latest || compareVersionsDesc(latest, pkg.version) >= 0) {
        continue;
      }
      items.push({
        project,
        ecosystem: project.ecosystem,
        name: pkg.name,
        isDirect: pkg.isDirect,
        currentVersion: pkg.version,
        targetVersion: latest,
      });
    }
  }
  return { items, unresolved, held: [...held].sort((a, b) => a.localeCompare(b)) };
}

/**
 * Summary checklist of planned changes; returns the items the user kept. `isPicked` decides which
 * rows start checked (defaults to all) — the update-to-latest flow uses it to leave ordinary
 * transitive pins unchecked, since pinning every transitive to latest is far more invasive than
 * bumping directs. `tag` optionally appends a marker to a row's description (e.g. "prefer-latest").
 */
async function confirmSelection(
  items: FixPlanItem[],
  title: string,
  isPicked: (item: FixPlanItem) => boolean = () => true,
  tag: (item: FixPlanItem) => string | undefined = () => undefined
): Promise<FixPlanItem[] | undefined> {
  const picks = items.map((item) => {
    const extra = tag(item);
    return {
      label: `${item.name}  ${item.currentVersion} → ${item.targetVersion}`,
      description: `${item.project.name} · ${item.isDirect ? 'update' : 'pin'}${extra ? ` · ${extra}` : ''}`,
      picked: isPicked(item),
      item,
    };
  });
  const picked = await vscode.window.showQuickPick(picks, {
    title,
    placeHolder: 'Toggle the changes to apply, then press OK',
    canPickMany: true,
    matchOnDescription: true,
  });
  return picked ? picked.map((p) => p.item) : undefined;
}

interface PreviewRequest {
  ecosystem: Ecosystem;
  name: string;
  currentVersion: string;
  /** What will be written to the manifest — a pinned version or a range. Shown to the user. */
  targetVersion: string;
  /** Concrete version whose dependencies drive the diff; defaults to `targetVersion` when absent. */
  resolvedVersion?: string;
  isDirect: boolean;
  project: Project;
  projectCount: number;
}

/** Fetch the target version's dependency diff and show it for confirmation before applying. */
async function previewAndConfirm(
  tree: DependencyTreeProvider,
  req: PreviewRequest
): Promise<boolean> {
  const resolved = req.resolvedVersion ?? req.targetVersion;
  try {
    const preview = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Analyzing ${req.name}@${resolved}…`,
      },
      () =>
        computeBumpPreview(
          req.ecosystem,
          req.name,
          req.currentVersion,
          resolved,
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

interface VersionChoice {
  /** Concrete version the user selected — used for the dependency preview and comparisons. */
  concrete: string;
  /** Exact string to write to the manifest: a pinned version or a range like `^1.2.3` / `[1.2.3,)`. */
  spec: string;
}

async function pickVersion(
  ecosystem: Ecosystem,
  name: string,
  currentVersion: string,
  projectDir: string
): Promise<VersionChoice | undefined> {
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
    const typed = await vscode.window.showInputBox({
      title,
      prompt: `Version or range for ${name}`,
      value: currentVersion,
    });
    return typed?.trim() ? asChoice(typed.trim()) : undefined;
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
    const typed = await vscode.window.showInputBox({ title, prompt: `Version or range for ${name}` });
    return typed?.trim() ? asChoice(typed.trim()) : undefined;
  }

  // The user picked a concrete version; now let them pin it or wrap it in a range.
  const spec = await pickRange(ecosystem, picked.label);
  return spec ? { concrete: picked.label, spec } : undefined;
}

/** A user-typed string is both what we write and (best-effort) the concrete version we preview. */
function asChoice(input: string): VersionChoice {
  return { concrete: extractConcreteVersion(input) ?? input, spec: input };
}

/** Pull a plain version out of a range spec for preview purposes (e.g. `^1.2.3` / `[1.2.3,)` → `1.2.3`). */
function extractConcreteVersion(spec: string): string | undefined {
  return /\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/.exec(spec)?.[0];
}

interface RangeOption {
  label: string;
  spec: string;
  detail: string;
}

/** Offer to write the chosen `version` as an exact pin or an ecosystem-appropriate range. */
async function pickRange(ecosystem: Ecosystem, version: string): Promise<string | undefined> {
  const options = ecosystem === 'npm' ? npmRangeOptions(version) : nugetRangeOptions(version);
  const items = options.map((o) => ({ label: o.label, description: o.spec, detail: o.detail }));
  const customLabel = '$(edit) Enter a custom range…';
  items.push({ label: customLabel, description: '', detail: 'Type any valid range yourself' });

  const picked = await vscode.window.showQuickPick(items, {
    title: `How should ${version} be written?`,
    placeHolder: 'Pin the exact version, or allow a range',
  });
  if (!picked) {
    return undefined;
  }
  if (picked.label === customLabel) {
    const custom = await vscode.window.showInputBox({
      title: `Custom range for ${version}`,
      value: version,
      prompt:
        ecosystem === 'npm'
          ? 'e.g. ^1.2.3, ~1.2.3, >=1.2.3 <2.0.0'
          : 'e.g. [1.2.3,2.0.0), 1.2.*, [1.2.3]',
    });
    return custom?.trim() || undefined;
  }
  return picked.description; // the resolved spec
}

function npmRangeOptions(v: string): RangeOption[] {
  return [
    { label: 'Exact', spec: v, detail: 'Pin to exactly this version' },
    { label: 'Compatible (^)', spec: `^${v}`, detail: 'Allow later minor & patch releases' },
    { label: 'Approximate (~)', spec: `~${v}`, detail: 'Allow later patch releases only' },
    { label: 'Minimum (>=)', spec: `>=${v}`, detail: 'This version or any newer release' },
  ];
}

function nugetRangeOptions(v: string): RangeOption[] {
  const options: RangeOption[] = [
    { label: 'Exact', spec: `[${v}]`, detail: 'Exactly this version — NuGet [x] syntax' },
    { label: 'Minimum', spec: v, detail: 'This version or newer (NuGet resolves the lowest available ≥)' },
  ];
  const parts = v.split('-')[0].split('.');
  if (parts.length >= 2 && parts.every((p) => /^\d+$/.test(p))) {
    options.push({
      label: 'Floating patch',
      spec: `${parts[0]}.${parts[1]}.*`,
      detail: 'Highest patch within this minor (e.g. 1.2.*)',
    });
    options.push({
      label: 'Floating minor',
      spec: `${parts[0]}.*`,
      detail: 'Highest minor within this major (e.g. 1.*)',
    });
  }
  return options;
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
      // The single-package flow passes an explicit user-chosen spec (pin or range) — write it as-is.
      await applyToProject(ecosystem, name, version, target, true);
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
  target: PackageLocation,
  literal = false
): Promise<void> {
  if (target.isDirect) {
    if (ecosystem === 'npm') {
      await updateNpmDirect(target.project, name, version, literal);
    } else {
      await updateNugetDirect(target.project, name, version);
    }
  } else if (ecosystem === 'npm') {
    if (target.project.packageManager === 'pnpm') {
      await overridePnpm(target.project, name, version);
    } else {
      await overrideNpm(target.project, name, version, literal);
    }
  } else {
    await overrideNuget(target.project, name, version);
  }
}

/* ---------------------------------- npm ---------------------------------- */

async function updateNpmDirect(
  project: Project,
  name: string,
  version: string,
  literal = false
): Promise<void> {
  const p = project.manifestPath;
  await writeFileWithUndo(p, npmUpdateDependency(fs.readFileSync(p, 'utf8'), name, version, literal));
}

async function overrideNpm(
  project: Project,
  name: string,
  version: string,
  literal = false
): Promise<void> {
  const p = project.manifestPath;
  await writeFileWithUndo(p, npmAddOverride(fs.readFileSync(p, 'utf8'), name, version, literal));
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

/** Distinct (command, dir) install runs for a set of projects — dedupes shared pnpm workspace roots. */
function installRuns(projects: Project[]): { cmd: string; dir: string }[] {
  const byCommand = new Map<string, Set<string>>();
  for (const project of projects) {
    const cmd = installCommandFor(project);
    if (!byCommand.has(cmd)) {
      byCommand.set(cmd, new Set());
    }
    byCommand.get(cmd)!.add(installDirFor(project));
  }
  const runs: { cmd: string; dir: string }[] = [];
  for (const [cmd, dirs] of byCommand) {
    for (const dir of dirs) {
      runs.push({ cmd, dir });
    }
  }
  return runs;
}

/**
 * Re-install dependencies for the given projects (the whole workspace, or a single right-clicked
 * project). Runs each distinct install command in turn, streaming to the output channel; the file
 * watcher refreshes the tree once lockfiles / project.assets.json are regenerated.
 */
async function reinstallDependencies(
  tree: DependencyTreeProvider,
  projects: Project[]
): Promise<void> {
  const runs = installRuns(projects);
  if (runs.length === 0) {
    vscode.window.showInformationMessage('Dependency Explorer: no projects to re-install.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Re-installing dependencies (${runs.length} command${runs.length === 1 ? '' : 's'})…`,
      cancellable: false,
    },
    async (progress) => {
      for (const { cmd, dir } of runs) {
        progress.report({ message: `${cmd} in ${path.basename(dir)}` });
        await runInstall(cmd, dir);
      }
    }
  );
  tree.refresh();
}

async function offerInstall(projects: Project[], message: string): Promise<void> {
  // A fix can touch npm, pnpm and NuGet projects at once, so there may be several install commands.
  const runs = installRuns(projects);
  const commands = [...new Set(runs.map((r) => r.cmd))];
  const action = await vscode.window.showInformationMessage(
    `${message} Run ${commands.map((c) => `"${c}"`).join(' / ')} to apply it — the tree refreshes automatically afterwards.`,
    commands.length === 1 ? `Run ${commands[0]}` : 'Run install commands'
  );
  if (!action) {
    return;
  }
  for (const { cmd, dir } of runs) {
    await runInstall(cmd, dir);
  }
}

let installOutput: vscode.OutputChannel | undefined;
function getInstallOutput(): vscode.OutputChannel {
  if (!installOutput) {
    installOutput = vscode.window.createOutputChannel('Dependency Explorer');
  }
  return installOutput;
}

/**
 * Run an install command in `dir`, streaming its output to the extension's output channel. On a
 * peer-dependency conflict (`ERESOLVE`) offer a one-click retry with the ecosystem's accept-anyway
 * flag, so a vuln bump that strands the peer graph doesn't dead-end the user at a raw npm error.
 */
async function runInstall(command: string, dir: string): Promise<void> {
  const { code, output } = await execInDir(command, dir);
  if (code === 0) {
    return;
  }

  const retryFlag = peerDepsRetryFlag(command);
  if (retryFlag && isPeerConflict(output)) {
    const retry = await vscode.window.showWarningMessage(
      `"${command}" in ${path.basename(dir)} failed on a peer-dependency conflict. Retrying with ${retryFlag} accepts a resolution npm considers incorrect (and possibly broken) — you may instead need to bump the conflicting package too.`,
      { modal: false },
      `Retry with ${retryFlag}`,
      'Show output'
    );
    if (retry === `Retry with ${retryFlag}`) {
      await runInstall(`${command} ${retryFlag}`, dir);
    } else if (retry === 'Show output') {
      getInstallOutput().show();
    }
    return;
  }

  const show = await vscode.window.showWarningMessage(
    `"${command}" in ${path.basename(dir)} failed (exit ${code}).`,
    'Show output'
  );
  if (show) {
    getInstallOutput().show();
  }
}

/** Spawn `command` in `dir`, mirroring its output to the output channel; resolves with exit code. */
function execInDir(command: string, dir: string): Promise<{ code: number; output: string }> {
  const channel = getInstallOutput();
  channel.show(true);
  channel.appendLine(`\n> ${command}  (${dir})`);
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: dir, shell: true });
    let output = '';
    const capture = (buf: Buffer) => {
      const text = buf.toString();
      output += text;
      channel.append(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (err) => {
      channel.appendLine(`\n[failed to start: ${err.message}]`);
      resolve({ code: -1, output: output + err.message });
    });
    child.on('close', (code) => resolve({ code: code ?? 0, output }));
  });
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
