# Changelog

All notable changes to the **Dependency Explorer** extension are documented here.

## 1.2.0

### Added

- **Update All Packages to Latest** — a new command (title-bar ⬆️ button, command palette, and
  per-project context menu) that bumps *every* package to its latest published version, not just
  the vulnerable ones. Same scope choices as Fix All Vulnerabilities (a single project, a chosen
  subset, or the whole workspace). Direct dependencies start checked in the confirmation list;
  transitive pins are opt-in (unchecked by default) so a routine update doesn't pin the whole
  transitive tree unless you ask it to.
- **Always-latest list** — flag packages you always want on the newest version, via a dependency's
  right-click **Always Update to Latest Version** or the `dependencyExplorer.alwaysLatestPackages`
  setting (supports `*` wildcards such as `@myorg/*`). Flagged packages are pre-checked and tagged
  `★ always-latest` in the Update All to Latest checklist, and during **Fix All Vulnerabilities**
  they jump straight to the latest version instead of stopping at the nearest safe one (as long as
  that latest version is itself non-vulnerable).

## 1.1.0

- Fix All Vulnerabilities across a single project, a chosen subset, or the whole workspace, with a
  peer-dependency conflict retry.
- Custom feed support for version lists and preview diffs (`.npmrc` / `NuGet.config`, including
  private registries and auth).
- pnpm lockfile support (v6, v9, and the pnpm 11 multi-document layout) including workspaces.

## 1.0.0

- Initial Marketplace release: full direct + transitive dependency tree for npm, pnpm and NuGet,
  OSV.dev vulnerability flags, in-place update / override, cross-project bumps, and pre-apply
  preview diffs.
