# Changelog

All notable changes to the **Dependency Explorer** extension are documented here.

## 1.6.2 — 2026-07-08

### Changed

- **The extension is now bundled with esbuild** — it ships as a single minified file instead of the
  full source tree plus `node_modules`, so the package is smaller and loads faster in the editor. No
  behavioural change.

## 1.6.1 — 2026-07-08

### Changed

- **Bulk operations skip sub-dependencies for speed** — **Fix All Vulnerabilities** and **Update All
  Packages to Latest** now only consider **direct** dependencies, so they no longer fetch versions
  for the (often far larger) transitive set and complete much faster. A routine pass updates your
  main dependencies without touching sub-dependencies. To act on a specific sub-dependency, right-
  click it → **Override / Pin Version…** (which resolves just that one on demand), or add it to the
  prefer-latest list to opt it back into the bulk runs. Skipped transitive packages are reported —
  by name for a vulnerability fix, so you know which still need pinning.

## 1.6.0 — 2026-07-08

### Added

- **Update-confidence layer on every update prompt** — the moment you're deciding whether to bump a
  package, the extension now shows what you need to decide it, without leaving the editor.
  - **Semver risk badges** — each bump is tagged `⚠ major`, `minor`, `patch`, or `pre-release` from
    the version distance (major/minor/patch, tolerant of NuGet 4-part versions and prereleases).
    Badges appear in the **Fix All Vulnerabilities** and **Update All Packages to Latest**
    checklists, next to every version in the update / override picker, and in the pre-apply preview
    panel — where a major bump also gets a "may include breaking changes" banner. In **Update All
    Packages to Latest**, major (potentially breaking) bumps now start **unchecked** unless the
    package is on your prefer-latest list, so a routine "update everything" pass doesn't silently
    opt you into breaking changes.
  - **Deprecation flags** — packages whose resolved version the registry marks deprecated are shown
    with a `⛔`/circle-slash marker and a `deprecated` tag in the tree, flagged per-version in the
    picker, and called out (with the registry's deprecation message) in the preview panel. Reads
    npm's per-version `deprecated` field and NuGet's registration `deprecation` metadata.
  - **Changelog / release-notes links per package** — a dependency's tooltip now links to its
    **Repository**, **Changelog / releases** (the GitHub releases page when the repo is hosted
    there), **Homepage**, and public registry page, plus a "Latest published" hint with its own risk
    badge. Repository URLs are normalized from the many shapes npm and NuGet declare them in
    (`git+ssh`, `github:` shorthand, nuspec `<repository>` / `<projectUrl>`, etc.).
- **"Why Is This Here?" — reverse-dependency view** — right-click any dependency (direct or
  transitive) to see every chain from your project's direct dependencies down to that package,
  answering why a transitive package is present. Chains are listed shortest-first (the most
  actionable), dev-only chains are tagged, and packages that resolve to more than one version in the
  project are flagged. Works across npm, pnpm and NuGet, walking each provider's resolved graph via
  reverse-reachability so even large trees enumerate quickly.

### Notes

- The new registry-metadata lookups (deprecation and links) are best-effort and cached per session:
  they're fetched lazily in the background as tree nodes render — so nothing blocks on the network —
  and a feed that doesn't expose the metadata simply shows less. Private/authenticated feeds reuse
  the same `.npmrc` / `NuGet.config` resolution (including the v1.4.0 credential-provider support)
  as version lookups.

## 1.5.0 — 2026-07-07

### Added

- **Bump .NET & Aspire Versions…** — a new command (title-bar rocket icon, command palette, or a
  project's right-click menu) for upgrading a .NET Aspire solution in one pass. Pick a single target
  Aspire version and it's applied to the `Aspire.AppHost.Sdk` **and** every first-party `Aspire.*`
  package across the chosen scope (all NuGet projects, a chosen subset, or one project) — these ship
  in lockstep, so they move together. In the same flow you can *optionally* move the .NET
  `<TargetFramework>` too (or leave it unchanged). Every change — each package, the SDK, and each
  target-framework edit — is shown in a pre-checked confirmation list before anything is written, and
  `dotnet restore` is offered afterwards. An Aspire package the feed doesn't publish at the chosen
  version is left untouched and reported, so a non-existent version is never written. Central Package
  Management is honored (versions in `Directory.Packages.props`), as is a `<TargetFramework>`
  centralized in `Directory.Build.props`.
- **Bump .NET Version…** — a standalone command that changes only the `<TargetFramework>` across a
  chosen set of NuGet projects (whole solution or a subset), with no Aspire involvement — for plain
  .NET solutions or when you just want to move the framework. Multi-target (`<TargetFrameworks>`)
  projects are reported and left for you to edit by hand.

## 1.4.0 — 2026-07-07

### Added

- **Azure DevOps credential-provider support** — private NuGet feed lookups now authenticate on a
  developer machine where the token lives in the Microsoft Artifacts Credential Provider (the store
  `dotnet` and Visual Studio use) rather than in `NuGet.config`. When a feed returns 401/403 and no
  credentials are found in `NuGet.config` or the environment, the extension invokes the provider
  non-interactively (`-OutputFormat Json`) and retries with the token it returns — running it at most
  once per feed per session. If you're not signed in it fails fast with a clear auth error (run
  `dotnet restore` once to sign in, then refresh). Honors `NUGET_PLUGIN_PATHS` for a custom provider
  location. This also covers self-hosted Azure DevOps Server, since it triggers on the 401 rather
  than the feed hostname.
- **`ARTIFACTS_CREDENTIALPROVIDER_EXTERNAL_FEED_ENDPOINTS`** — the modern credential-provider env var
  is now read in addition to the legacy `VSS_NUGET_EXTERNAL_FEED_ENDPOINTS` (CI / injected creds).
- **Automated test suite** — `npm test` compiles and runs `node --test`, covering feed resolution,
  NuGet authentication, and bulk-plan concurrency.

### Changed

- **Bulk operations resolve versions in parallel** — **Fix All Vulnerabilities** and **Update All
  Packages to Latest** now look up package versions concurrently (up to 8 at a time) instead of one
  at a time, so large workspaces complete far faster.
- **A dead or slow NuGet feed no longer stalls a bulk run per package** — each service index is now
  probed once per run under its own 8-second budget (independent of the 30-second per-package
  timeout), and an unreachable feed is briefly remembered so the rest of the run skips it instantly
  instead of re-probing it for every package.

### Fixed

- **NuGet authentication failures are reported as such** — a 401/403 from a private/Azure feed now
  surfaces as `authentication failed (HTTP 401) — this feed needs valid credentials` instead of the
  misleading "service index unreachable".
- **Basic-auth credentials with no `<Username>`** — a `NuGet.config` `ClearTextPassword` (or
  DPAPI-encrypted `<Password>`) that omits the username no longer sends an empty Basic username,
  which Azure DevOps rejects; a non-empty placeholder is used, matching the env/credential-provider
  paths.

## 1.3.0 — 2026-07-06

### Added

- **Version ranges** — after picking a version in the update / override flow, choose how it's
  written to the manifest: an exact pin, or a range. npm/pnpm offer `^`, `~`, and `>=`; NuGet
  offers floating (`1.2.*`, `1.*`) and exact/minimum bracket syntax (`[1.2.3]`, `[1.2.3,)`), plus a
  custom-range option. Explicit ranges are written verbatim (no more double `^^`), while bulk
  operations keep preserving your existing range style. The dependency preview is computed from the
  concrete version you selected.
- **Never-update list** — flag packages to hold back from both bulk operations, via a dependency's
  right-click **Never Update This Package** or the `dependencyExplorer.neverUpdatePackages` setting
  (supports `*` wildcards such as `@myorg/*`). Held-back packages are skipped by **Fix All
  Vulnerabilities** *and* **Update All Packages to Latest** — including when vulnerable — and are
  reported afterwards so you know what was left untouched. A manual single-package update still works
  but prompts for confirmation first. When a package is on both this and the prefer-latest list,
  never-update takes precedence during bulk runs.
- **Toggle the prefer-latest / never-update lists from the tree** — the right-click actions flip to
  **Remove from Prefer-Latest List** / **Remove from Never-Update List** once a package is on the
  respective list, so you can clear a flag without editing settings. (A package flagged only via a
  `*` wildcard isn't removed automatically — the wildcard is named so you can edit it yourself.)
- **Re-install dependencies** — right-click a project for **Re-install Dependencies**, or use the
  new title-bar button / **Re-install Dependencies in All Projects** command to re-install every
  open project at once. Runs each distinct install command (`npm install` / `pnpm install` /
  `dotnet restore`) once — deduping shared pnpm workspace roots — streaming to the output channel,
  then refreshes the tree. Works on unrestored NuGet projects (no `project.assets.json` yet).
- **Resilient bulk operations** — version resolution now has a 30-second per-package timeout, so a
  slow or unreachable feed no longer stalls a bulk run. Packages that can't be resolved are skipped,
  listed for you, and offered up for manual version entry instead of failing the whole operation.

### Changed

- **Renamed "Always Update to Latest Version" to "Prefer Latest Version"** (row tag `★ always-latest`
  → `★ prefer-latest`) to better reflect what it does: during **Fix All Vulnerabilities** a flagged
  package targets its latest version only when that version is itself non-vulnerable, otherwise it
  falls back to the nearest safe one; during **Update All Packages to Latest** it just pre-checks the
  row. It has no effect on single-package updates. The setting key (`alwaysLatestPackages`) is
  unchanged, so existing configuration keeps working.

### Fixed

- **NuGet version resolution on custom / private feeds.** Version lists and preview diffs now work
  on feeds that don't expose a flat container — GitHub Packages and similar are read via the
  registrations endpoint, and legacy V2 (OData) feeds are supported too. Authentication covers more
  setups: encrypted `<Password>` entries (decrypted via DPAPI on Windows), the
  `VSS_NUGET_EXTERNAL_FEED_ENDPOINTS` credential provider used by Azure Artifacts, and
  `<ClearTextPassword>` without a username.

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
