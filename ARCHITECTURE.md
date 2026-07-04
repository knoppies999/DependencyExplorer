# Dependency Explorer — Architecture & Operations

> Internal engineering doc. Written for a future Claude session starting cold. It captures both
> the code design **and** the environment/toolchain quirks that are expensive to rediscover.
> If you change behavior, update this file in the same commit.

## 1. What this is

A VS Code extension that shows the **full dependency tree (direct + transitive)** for **npm**,
**pnpm** and **NuGet** projects in a workspace, flags packages with known vulnerabilities (via
OSV.dev), and lets the user fix them by **updating** a direct dependency or **overriding/pinning** a
transitive one — editing the manifest files in place. Extra features layered on top:

- Multi-project: every npm/pnpm/NuGet project in the workspace is its own top-level tree node
  (a pnpm workspace contributes one node per importer).
- Cross-project "bump a duplicate everywhere it appears" (one action fixes N projects), with an
  all / only-origin / **choose-specific-projects** scope picker.
- **Fix all vulnerabilities** across a single / all / chosen subset of projects: bumps each
  vulnerable package to its nearest safe version (direct → update, transitive → pin). Re-runnable.
- **Update all packages to latest** across a single / all / chosen subset of projects: bumps *every*
  package (not just vulnerable ones) to its latest published version (direct → update, transitive →
  pin), skipping anything already current. Directs start checked in the confirm list; transitive
  pins are opt-in (unchecked by default) since pinning the whole transitive tree is far more invasive.
- **Always-latest list** (`dependencyExplorer.alwaysLatestPackages` setting): packages that always
  jump to their latest version during *any* upgrade — including the vulnerability fix flow (a matched
  package targets latest instead of nearest-safe, provided that latest is itself safe).
- A pre-apply **preview** webview diffing the target version's declared dependencies vs the current.
- Central Package Management (CPM) support for NuGet, including transitive pinning.
- **Custom feeds:** version lists and preview diffs read the project's own `.npmrc` / `NuGet.config`
  (custom registries + private V3 sources, with env-var-expanded auth), not just the public ones.

Language: TypeScript, compiled with `tsc` to `out/`. Runtime deps: `jsonc-parser` + `yaml`.

## 2. Environment & toolchain facts (READ FIRST — these bite)

- **Two separate directories:**
  - Extension repo: `C:\Dev stuff\Copilot\DependencyExtension` (this repo, on GitHub).
  - Test workspace: `C:\Dev stuff\Copilot\DependencyTestWorkspace` — **NOT part of the repo**, a
    sibling folder. You open *that* folder in the Extension Development Host to test. See §9.
- **Node is NOT on PATH** in either shell. It's winget-installed at
  `C:\Program Files\nodejs\node.exe` / `npm.cmd`. Every PowerShell command that needs node must
  prefix: `$env:Path = "$env:ProgramFiles\nodejs;$env:Path";` (Bash: `export PATH="/c/Program Files/nodejs:$PATH"`).
- **dotnet IS on PATH** (`C:\Program Files\dotnet\dotnet.exe`, v10 SDK). Used only to generate
  `obj/project.assets.json` via `dotnet restore` in the test workspace — the extension itself never
  shells out to dotnet.
- **PowerShell tool working directory drifts** between calls unexpectedly. Always
  `Set-Location "C:\Dev stuff\Copilot\DependencyExtension"` before `npm run compile`, etc.
- **The Bash tool is a minimal git-bash**: `cat`, `grep`, `cp`, `ls`, `head`, `tail`, `which`,
  `find` are frequently MISSING (exit 127). Use dedicated tools (Read/Glob/Grep) or PowerShell
  instead. For `git commit` with a multi-line message, `cat <<EOF` fails — write the message to a
  file and use `git commit -F <file>`.
- **Publishing**: publisher id is `RuanduPlessis` (must match `package.json` `publisher`). GitHub
  repo: `https://github.com/knoppies999/DependencyExplorer`. `gh` CLI is not installed. Marketplace
  upload is via the web UI (marketplace.visualstudio.com/manage) or `vsce publish` with a PAT.

## 3. Data flow (one paragraph)

`activate()` builds one `OsvService`, the two providers `[NpmProvider, NugetProvider]`, and a
`DependencyTreeProvider`. On `refresh()` the tree calls each provider's `scan()` (finds & parses
manifests → `Project[]`), renders project nodes, and asynchronously fires an OSV batch query; when
vulnerability data returns it calls each provider's `applyVulnerabilities(project)` and fires a tree
change so icons update. Tree expansion is **lazy**: `getChildren` → provider
`getDirectDependencies` / `getChildDependencies` build `DependencyNode`s on demand. User actions
(update/override, from inline icons or the palette) run through `commands.ts`, which fetches a
version, shows the preview webview, optionally asks cross-project scope, then writes manifest files
via the pure functions in `manifestEditor.ts`.

## 4. Module reference (`src/`)

- **`types.ts`** — shared types. `Ecosystem = 'npm' | 'NuGet'`. `Project` (ecosystem, manifestPath,
  name, optional `error`). `DependencyNode` (name, version, isDirect, isDev, hasChildren, circular,
  `vulns`, `subtreeVulnerable`, `ancestorKeys`, provider-internal `key`). `PackageLocation`,
  `DuplicatePackage`. **`DependencyProvider`** interface — the contract every ecosystem implements
  (see §6).
- **`extension.ts`** — `activate()`. Registers the `TreeView`, commands, and a debounced
  (1500 ms) `FileSystemWatcher` on `**/{package.json,package-lock.json,*.csproj,*.fsproj,*.vbproj,project.assets.json,Directory.Packages.props}`
  (ignores paths containing `node_modules`) that calls `tree.refresh()`.
- **`tree/dependencyTree.ts`** — `DependencyTreeProvider implements vscode.TreeDataProvider`.
  Owns `scan()` (aggregates all providers, sorts), `scanVulnerabilities()` (OSV batch → per-project
  `applyVulnerabilities` → fire change), `getChildren`/`getTreeItem`. **Icon logic:**
  `vulns.length > 0` → red `warning` (`list.errorForeground`); else `subtreeVulnerable` → yellow
  `warning` (`list.warningForeground`); else `package`. A **project node** with any vulnerable
  package renders the same red `warning` icon plus a `⚠ N vulnerable` suffix in its description
  (via `getProjectVulnerabilitySummary`); otherwise the ecosystem icon. Sets `contextValue`:
  `project`, `dep:direct`, `dep:transitive` (drives menu `when` clauses). Also hosts cross-project
  helpers `locateAcrossProjects`, `findDuplicatePackages`, and `getTargetFramework` (delegates to
  provider), plus the bulk-fix helpers `getProjects`, `ensureVulnerabilities` (awaits scan + OSV
  load), `getVulnerablePackages` (one entry per vulnerable name, newest version),
  `getProjectVulnerabilitySummary` (badge counts), and `loadSafety`/`isSafeVersion` (batch-query OSV
  for candidate fix versions).
- **`providers/npmProvider.ts`** — provider for the npm ecosystem, covering **both** npm and pnpm.
  `scan()` finds `pnpm-lock.yaml` files first (each importer → one `Project`, claiming its
  `package.json`), then `package.json` files with a `package-lock.json`. Everything below `scan()`
  walks a common `ResolvedGraph`, so the tree/cycle/vuln logic is format-agnostic. Cycle detection
  via `ancestorKeys`. Sets `Project.packageManager` (`'npm' | 'pnpm'`) and, for pnpm, `workspaceRoot`.
- **`providers/resolvedGraph.ts`** — the `ResolvedGraph` interface (`directProd`/`directDev` as
  `DepRef{name,key?}`, `entry(key)`, `children(key)`, `allPackages()`, `keys()`) both lockfiles
  compile to. Everything is keyed by an opaque string `key`.
- **`providers/npmGraph.ts`** — `buildNpmGraph(packages, prod, dev)` for `package-lock.json` v2/v3
  (`packages` map; key `""` is root, keys like `node_modules/a/node_modules/x`). Implements the
  **node_modules walk-up** resolution (own `node_modules`, then walk up parent scopes) — the crux of
  correct npm transitive resolution; **do not** replace with naive name lookup. v1 (no `packages`) →
  project `error`.
- **`providers/pnpmGraph.ts`** — `buildPnpmGraphs(lockText)` parses `pnpm-lock.yaml` **v6** (keys
  prefixed `/`, edges inline in `packages`) and **v9** (keys unprefixed, edges in `snapshots`),
  returning one `ResolvedGraph` per importer. **pnpm 11** keeps `lockfileVersion: '9.0'` but writes a
  **multi-document YAML** — an "env" document (`configDependencies`/`packageManagerDependencies`) plus
  the real project document (`importers`/`packages`/`snapshots`). `selectProjectLockfile` runs
  `parseAllDocuments` and picks the document that actually carries the graph, so the v9 logic below is
  reused unchanged; **don't** revert to the single-doc `parse()` (it only sees the env document and
  would report the whole workspace as an unsupported/empty lockfile). Child keys are rebuilt as `prefix+name@versionRef`
  (peer suffixes preserved); `link:` workspace refs resolve to nothing. Unknown version → throws,
  surfaced as project `error`. The `packages`/`snapshots` maps are shared across importers, so each
  importer's `allPackages()`/`keys()` are scoped to the packages **reachable from its own directs**
  (`reachableKeys`) — otherwise a workspace root would report other importers' vulnerabilities.
- **`providers/nugetProvider.ts`** — parses `obj/project.assets.json`. Direct deps from
  `project.frameworks[tfm].dependencies` (filtering `autoReferenced`), falling back to
  `projectFileDependencyGroups`. Resolved graph from `targets[tfm]` (prefers the plain TFM target
  over RID-specific `net8.0/win-x64`). `libs` map keyed by **lowercased** package id (NuGet resolves
  one version per id per framework). Reads versions the same whether classic or CPM — assets.json is
  post-restore truth. `getTargetFramework()` returns the TFM (used by preview).
- **`services/vulnClosure.ts`** — `computeVulnClosure(keys, getChildren, isVulnerable)`. Returns the
  set of keys that can reach a vulnerable key (the vulnerable node itself + all ancestors) via
  **reverse reachability** (build parent edges, BFS out from vulnerable nodes). This is
  cycle-safe and order-independent. **Do not** revert to recursive DFS+memo+on-stack-cycle-cut — that
  was the original bug: a node first reached mid-cycle got memoized "clean," dropping the warning on
  intermediates above a deep vulnerable package. Both providers' `applyVulnerabilities` feed their
  graph into this.
- **`services/osvService.ts`** — batches to `POST https://api.osv.dev/v1/querybatch` (BATCH_SIZE
  500). Caches results per `ecosystem:name@version` for the session. `query()` returns whether new
  data arrived (so the tree only re-fires when something changed). Warns once on failure; tree still
  works without vuln data.
- **`services/registryService.ts`** — `fetchVersions(ecosystem, name, projectDir)` →
  `{versions[], latest}`. Resolves the feed via `feedConfig` for `projectDir`: npm hits the
  configured registry's abbreviated packument; NuGet queries every mapped/enabled source's V3 flat
  container and unions the results. Public registries are the fallback when no config applies.
  `compareVersionsDesc` is a lightweight semver-ish sort (4-part NuGet versions, prereleases below
  stable).
- **`services/fixPlanner.ts`** — pure `nearestSafeVersion(versionsDesc, current, isSafe, compare,
  isPrerelease)` (smallest version above `current` that `isSafe` accepts, stable preferred) +
  `FixPlanItem` type (reused by both the fix-vulnerabilities and update-to-latest flows). No
  network/`vscode`, so unit-tested.
- **`services/packageMatch.ts`** — pure `matchesAnyPattern(name, patterns)` for the always-latest
  list: case-insensitive, `*` wildcards (e.g. `@myorg/*`), blanks ignored. `vscode`-free, unit-tested.
- **`services/feedConfig.ts`** — **`vscode`-free** feed resolver (so it's unit-testable). Parses
  `.npmrc` (project-dir-upward + `~`) → `resolveNpmFeed(name, dir)` = `{baseUrl, headers}` (scoped
  registry, `_authToken`/`_auth`/`username`+`_password`, `${ENV}` expansion). Parses `NuGet.config`
  (project-dir-upward + `%APPDATA%/NuGet`) honoring `<clear/>`, `disabledPackageSources`,
  `packageSourceCredentials` (`ClearTextPassword`→Basic; DPAPI `Password` skipped w/ one-time warn),
  and `packageSourceMapping` → `resolveNugetSources(name, dir)`. `getNugetFlatContainer(source)`
  discovers a V3 `PackageBaseAddress` (cached). All config + service-index results cached per session
  (`_resetFeedCaches()` for tests).
- **`services/previewService.ts`** — `computeBumpPreview(ecosystem, name, currentVersion,
  targetVersion, projectDir, tfm?)` (feed-aware via `feedConfig`, same as registryService). Fetches
  the **declared** dependencies of both versions and diffs them
  (`added`/`removed`/`changed`/`unchanged`). npm: per-version endpoint
  `registry.npmjs.org/<name>/<version>` (has `dependencies`, `optionalDependencies`). NuGet:
  `.nuspec` via flatcontainer, parsed by `parseNuspecDeps` which picks the `<group>` matching the
  project TFM (normalized) else a framework-agnostic/first group. Current-version fetch is
  best-effort (`currentUnavailable` flag). **Important scope note:** this diffs *declared
  requirements*, NOT a fully-resolved transitive tree (that would require reimplementing the
  resolver). The panel says so explicitly.
- **`ui/previewPanel.ts`** — `confirmBump(opts): Promise<boolean>`. Creates a themed webview
  (VS Code CSS vars, CSP + nonce), renders the diff table + summary chips + Apply/Cancel, resolves
  true on Apply, false on Cancel/dispose.
- **`services/manifestEditor.ts`** — **pure string→string** edit functions (the only place manifest
  text is mutated; all unit-tested). npm: `npmUpdateDependency` (preserves `^`/`~`/exact range
  style), `npmAddOverride` (when the package is *also* a direct dependency, bumps that direct range
  and writes the override as npm's `$name` self-reference — a literal version there throws `EOVERRIDE:
  Override … conflicts with direct dependency` at install), `pnpmAddOverride` (writes `pnpm.overrides`).
  NuGet: `csprojUpdateVersion`
  (matches `Version="..."`, then
  `VersionOverride="..."`, then `<Version>..</Version>` element; returns `undefined` if none —
  signals caller to try props), `propsUpdateVersion`, `propsSetPackageVersion`,
  `csprojAddPackageReference(name, version?)`, `insertIntoItemGroup`, and `detectCpmMode(propsXml,
  projXml)` → `{enabled, transitivePinning}`.
- **`commands.ts`** — the orchestration. `registerCommands`. `runFix(tree, ecosystem, name,
  currentVersion, originProject)` is the node-triggered flow: pickVersion → previewAndConfirm →
  chooseScope (if the package is in >1 project) → applyAndOffer. `pickVersion`/`previewAndConfirm`
  pass the origin project's dir (`dirOf`) so `feedConfig` can resolve its custom feeds.
  `fixAcrossProjects` is the palette entry (pick a shared package first). `chooseScope` offers
  all / only-origin (node flow) / **Choose specific projects…** → `selectProjects` (a
  `canPickMany` checklist). `applyToProject` routes: direct → update, transitive → override, per
  ecosystem **and** package manager (pnpm transitive → `pnpmAddOverride` on the workspace-root
  `package.json`). `writeFileWithUndo` uses a `WorkspaceEdit` + `save()`. `offerInstall` groups
  affected dirs by install command (`npm install` / `pnpm install` at the workspace root /
  `dotnet restore`) and runs each via `runInstall` — `spawn` (shell) streaming to the "Dependency
  Explorer" output channel. On a non-zero exit whose output `isPeerConflict` recognises (`ERESOLVE`),
  it offers a one-click retry with the ecosystem's accept-anyway flag (`peerDepsRetryFlag`: npm
  `--legacy-peer-deps`, pnpm `--no-strict-peer-dependencies`) — a vuln bump can pick a safe version
  that strands the *peer* graph, which the resolver-free planner can't foresee; the pure detection
  lives in `services/installRetry.ts`. `fixAllVulnerabilities(tree, project?)` is the
  bulk flow, reached by **two** command ids: `fixAllVulnerabilities` (title-bar/palette, ignores any
  arg so it always shows the scope picker) and `fixProjectVulnerabilities` (project node inline/context,
  passes `node.project`). Keeping them separate avoids VS Code silently handing the title button the
  selected node. Flow: `tree.ensureVulnerabilities()` → scope (single project from a node, else all / choose) →
  `buildFixPlan` (per vulnerable package, `nearestSafeVersion` over registry versions, safety batched
  through `tree.loadSafety`/`isSafeVersion`) → a `canPickMany` summary checklist → `applyToProject`
  per item → `offerInstall`. Direct vulns update, transitive vulns pin; **no resolver**, so it's
  re-runnable (directs first, then reinstall/refresh drops fixed transitives; anything still flagged
  gets pinned on the next run). `buildFixPlan` also honors the **always-latest** setting
  (`alwaysLatestPatterns()` → `matchesAnyPattern`): a matched vulnerable package targets its `latest`
  version instead of nearest-safe, as long as `latest` is newer and OSV-safe (its `latest` is added
  to the safety batch). `updateAllToLatest(tree, project?)` is the parallel "bump everything" flow,
  reached by `updateAllToLatest` (title-bar/palette, ignores arg) and `updateProjectToLatest` (project
  context menu). It uses `tree.ensureScanned()` (no OSV needed) → scope → `buildUpdatePlan` (every
  distinct package via `tree.getAllDistinctPackages`, target = registry `latest`, packages already
  current dropped) → the same checklist/apply/install path, but passing `confirmSelection`'s
  `isPicked` predicate (`item.isDirect || matchesAnyPattern(name, alwaysLatest)`) so ordinary
  transitive pins start **unchecked** while directs and always-latest packages start checked (the
  latter also tagged `★ always-latest` via the `tag` callback). The shared pieces — `chooseProjectScope`,
  `confirmSelection`, `applyPlan`, `scopeLabel` — serve both flows. `addToAlwaysLatest(name)` (dep
  context menu) appends a package to the `alwaysLatestPackages` setting (workspace scope when a folder
  is open, else global).

## 5. Editing model (what each action writes)

| Action | Classic .NET | CPM .NET | npm | pnpm |
|---|---|---|---|---|
| Update **direct** | set `Version="..."` (or `VersionOverride`) in `.csproj` | set `<PackageVersion>` in `Directory.Packages.props` | bump range in `dependencies`/`devDependencies`, keep `^`/`~`/exact | same as npm (importer's `package.json`) |
| Override **transitive** | add versioned `<PackageReference>` pin to `.csproj` | add `<PackageVersion>` to props; **if transitive pinning off**, also add a versionless `<PackageReference>` to force it | add to `"overrides"` in `package.json` | add to `"pnpm.overrides"` in the **workspace-root** `package.json` |

Cross-project: `applyAndOffer` loops the chosen `PackageLocation[]`, applying the right action per
project based on that project's `isDirect`. After writing, the user runs install; the file watcher
auto-refreshes the tree.

## 6. Provider contract (`DependencyProvider`)

`scan(): Promise<Project[]>` · `getDirectDependencies(project)` · `getChildDependencies(node)` ·
`getAllPackages(project): PackageId[]` (for OSV) · `locate(project, name): {isDirect, version} |
undefined` (for cross-project) · `applyVulnerabilities(project)` (populates `state.vulnClosure` via
`computeVulnClosure`) · optional `getTargetFramework(project)`. Each provider keeps a private
`states` map keyed by `manifestPath`. `Project` also carries `packageManager` (`'npm' | 'pnpm'`) and
`workspaceRoot` (pnpm), which drive the install command and override target in `commands.ts` — note
that `providerFor` routes strictly by **`ecosystem`**, so pnpm lives inside `NpmProvider` rather than
as a second `'npm'` provider. To add an ecosystem, implement this interface and add the provider to
the array in `extension.ts`, plus registry/preview/OSV ecosystem branches.

## 7. Key invariants & concepts

- **Lazy tree + async vuln data:** nodes are (re)created on every `getChildren`, reading the current
  `vulnClosure`. When OSV data lands, `applyVulnerabilities` + a full fire re-creates visible nodes
  with correct icons. So closure correctness is what matters, not caching node objects.
- **`subtreeVulnerable`** = node's key ∈ `vulnClosure`. Vulnerable nodes are in the closure too but
  render red (vulns checked first); clean ancestors render yellow.
- **npm resolution** must go through `resolve()` (node_modules walk-up), never naive name lookup —
  the same name can resolve to different keys/versions at different tree depths.
- **NuGet keys are lowercased ids**; always `.toLowerCase()` when looking up `libs`.

## 8. Testing (no framework — hand-rolled node harnesses)

There is no Jest/Mocha. Tests are standalone node scripts that require the compiled `out/*.js` and
**mock `vscode`** by overriding `Module._resolveFilename` + injecting `require.cache['vscode']`
(providers only touch `vscode.workspace.findFiles` and `vscode.window.showWarningMessage`). Pure
services (`manifestEditor`, `vulnClosure`, `previewService`) need no vscode at all.

⚠️ **These harnesses live in the session scratchpad** (`…/scratchpad/*.js`), which is
**session-specific and will be gone in a fresh chat.** Recreate them from this pattern when needed.
The suites and what they cover (52 tests total when last run, all green):
- `editor-test.js` — pure `manifestEditor` fns incl. CPM detect / VersionOverride / props (22).
- `multi-harness.js` — multi-project scan + `locate` + `findDuplicatePackages`, incl. CPM (12).
- `preview-harness.js` — live npm + NuGet registry fetches + `parseNuspecDeps` + `diffDependencies` (6).
- `closure-test.js` — pure `computeVulnClosure`: clean intermediates, diamonds, cycles, order-independence (8).
- `closure-e2e-harness.js` — injects a fake vuln on a deep clean leaf (`ee-first`) in the express
  tree and asserts every ancestor gets `subtreeVulnerable` — the regression test for the icon bug (4).
- `feed-pnpm-test.js` — pure `feedConfig` (`.npmrc` scoped registry + `${ENV}` token + auth-by-origin;
  `NuGet.config` clear/disabled/clear-text-creds/`packageSourceMapping`), `pnpmGraph` (v6 + v9 +
  pnpm 11 multi-document + env-doc-ignored + order-independence + workspace importers +
  unsupported-version throw), and `pnpmAddOverride` (11). The `npmGraph` walk-up
  can be spot-checked with a nested-`node_modules` sample (root `x@1` vs a's nested `x@2`).
- `fixplan-test.js` — pure `nearestSafeVersion`: nearest safe above current, skips vulnerable
  candidates, stable-over-prerelease preference, undefined when none safe, 4-part NuGet ordering (7).
- `match-test.js` — pure `matchesAnyPattern` (always-latest list): exact case-insensitive match,
  trimming, blanks ignored, `*` scope/prefix/contains wildcards, regex metachars treated literally (16).

Compile before running: `Set-Location <repo>; $env:Path="$env:ProgramFiles\nodejs;$env:Path"; npm run compile`.

## 9. Test workspace (`C:\Dev stuff\Copilot\DependencyTestWorkspace`, separate from repo)

- `web-frontend/` (npm) & `api-server/` (npm) — share `express`, `lodash` (direct) and their whole
  transitive trees (`qs`, `cookie`, etc.); the user has been mutating versions/overrides here.
- `PaymentService/`, `OrderService/` (.NET, classic inline versions).
- `cpm-solution/` — `Directory.Packages.props` (CPM + `CentralPackageTransitivePinningEnabled=true`)
  with `InventoryService/` and `ShippingService/` using versionless `<PackageReference>`s.
- Regenerate resolution data: npm → `npm install --package-lock-only`; .NET → `dotnet restore`.
  Vulnerable versions are chosen on purpose so OSV lights things up.

## 10. Build / package / publish

- Compile: `npm run compile` (`tsc -p ./`). `vscode:prepublish` runs it automatically.
- Package: `Set-Location <repo>; npx --yes @vscode/vsce package` → `dependency-explorer-<ver>.vsix`.
  Works without `--allow-missing-repository` now that `package.json` has a `repository` field.
  `.vscodeignore` excludes `src/`, `.vscode/`, `.claude/`, maps, `*.ts`; vsce prunes devDeps, so the
  vsix ships `out/`, `media/`, `node_modules/{jsonc-parser,yaml}`, README, LICENSE.
- Marketplace icon: `media/icon.png` (256×256, indigo `#4B3FB0` bg + white node-tree glyph). It was
  rasterized from an HTML/SVG via **headless Edge** (`msedge --headless=new --screenshot`), since no
  ImageMagick/Inkscape is installed (`convert.exe` on this box is the Windows FS tool, not IM).
- Publish: web UI upload of the `.vsix`, or `vsce publish -p <PAT>` (PAT needs Marketplace→Manage).
  A given version can only be published once — bump `version` for each upload.

## 11. Known limitations / gotchas

- Preview shows **declared** deps, not a resolved tree (§4 previewService).
- NuGet multi-targeted projects show the first TFM's graph only.
- npm monorepo packages without their own lockfile show a "run npm install" hint; open the folder
  that has the lock.
- OSV severity levels aren't fetched (only IDs, linked to osv.dev).
- `insertIntoItemGroup` indentation is derived from the sibling line; keep the close-tag reinsertion
  logic if you touch it (there was an indentation bug here once).
- Custom feeds: only V3 NuGet sources (`.../index.json` with a `PackageBaseAddress`) are queried;
  legacy V2 feeds are skipped. DPAPI-encrypted NuGet `<Password>` can't be decrypted cross-platform,
  so those sources are queried anonymously (use `<ClearTextPassword>` + an env-var token).
- pnpm `link:` workspace dependencies show as unresolved leaves (not walked into the linked package).
  pnpm lockfile support is v6 + v9 + the pnpm 11 multi-document layout (all `lockfileVersion` 6/9);
  other versions surface a friendly project error.
