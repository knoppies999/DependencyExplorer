# Dependency Explorer — Architecture & Operations

> Internal engineering doc. Written for a future Claude session starting cold. It captures both
> the code design **and** the environment/toolchain quirks that are expensive to rediscover.
> If you change behavior, update this file in the same commit.

## 1. What this is

A VS Code extension that shows the **full dependency tree (direct + transitive)** for **npm** and
**NuGet** projects in a workspace, flags packages with known vulnerabilities (via OSV.dev), and lets
the user fix them by **updating** a direct dependency or **overriding/pinning** a transitive one —
editing the manifest files in place. Extra features layered on top:

- Multi-project: every npm/NuGet project in the workspace is its own top-level tree node.
- Cross-project "bump a duplicate everywhere it appears" (one action fixes N projects).
- A pre-apply **preview** webview diffing the target version's declared dependencies vs the current.
- Central Package Management (CPM) support for NuGet, including transitive pinning.

Language: TypeScript, compiled with `tsc` to `out/`. Runtime dep: `jsonc-parser` only.

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
  `warning` (`list.warningForeground`); else `package`. Sets `contextValue`: `project`,
  `dep:direct`, `dep:transitive` (drives menu `when` clauses). Also hosts cross-project helpers
  `locateAcrossProjects`, `findDuplicatePackages`, and `getTargetFramework` (delegates to provider).
- **`providers/npmProvider.ts`** — parses `package-lock.json` v2/v3 (`packages` map; key `""` is the
  root, keys like `node_modules/x`, `node_modules/a/node_modules/x`). **`resolve(fromKey, depName)`**
  implements node_modules walk-up resolution (look in own `node_modules`, then walk up parent
  scopes) — this is the crux of correct npm transitive resolution. `childNames` = `dependencies` +
  `optionalDependencies`. Cycle detection via `ancestorKeys`. Requires lockfile v2+ (has `packages`);
  v1 → project `error`.
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
- **`services/registryService.ts`** — `fetchVersions(ecosystem, name)` → `{versions[], latest}`.
  npm: `registry.npmjs.org/<name>` abbreviated packument. NuGet:
  `api.nuget.org/v3-flatcontainer/<lowerid>/index.json`. `compareVersionsDesc` is a lightweight
  semver-ish sort (handles 4-part NuGet versions, prereleases sort below stable).
- **`services/previewService.ts`** — `computeBumpPreview(ecosystem, name, currentVersion,
  targetVersion, tfm?)`. Fetches the **declared** dependencies of both versions and diffs them
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
  style), `npmAddOverride`. NuGet: `csprojUpdateVersion` (matches `Version="..."`, then
  `VersionOverride="..."`, then `<Version>..</Version>` element; returns `undefined` if none —
  signals caller to try props), `propsUpdateVersion`, `propsSetPackageVersion`,
  `csprojAddPackageReference(name, version?)`, `insertIntoItemGroup`, and `detectCpmMode(propsXml,
  projXml)` → `{enabled, transitivePinning}`.
- **`commands.ts`** — the orchestration. `registerCommands`. `runFix(tree, ecosystem, name,
  currentVersion, originProject)` is the node-triggered flow: pickVersion → previewAndConfirm →
  chooseScope (if the package is in >1 project) → applyAndOffer. `fixAcrossProjects` is the palette
  entry (pick a shared package first). `applyToProject` routes: direct → update, transitive →
  override, per ecosystem. `findPackagesProps` walks up for `Directory.Packages.props`.
  `writeFileWithUndo` uses a `WorkspaceEdit` + `save()` (so edits are undoable). `offerInstall`
  spawns one terminal per affected project dir running `npm install` / `dotnet restore`.

## 5. Editing model (what each action writes)

| Action | Classic .NET | CPM .NET | npm |
|---|---|---|---|
| Update **direct** | set `Version="..."` (or `VersionOverride`) in `.csproj` | set `<PackageVersion>` in `Directory.Packages.props` | bump range in `dependencies`/`devDependencies`, keep `^`/`~`/exact |
| Override **transitive** | add versioned `<PackageReference>` pin to `.csproj` | add `<PackageVersion>` to props; **if transitive pinning off**, also add a versionless `<PackageReference>` to force it | add to `"overrides"` in `package.json` |

Cross-project: `applyAndOffer` loops the chosen `PackageLocation[]`, applying the right action per
project based on that project's `isDirect`. After writing, the user runs install; the file watcher
auto-refreshes the tree.

## 6. Provider contract (`DependencyProvider`)

`scan(): Promise<Project[]>` · `getDirectDependencies(project)` · `getChildDependencies(node)` ·
`getAllPackages(project): PackageId[]` (for OSV) · `locate(project, name): {isDirect, version} |
undefined` (for cross-project) · `applyVulnerabilities(project)` (populates `state.vulnClosure` via
`computeVulnClosure`) · optional `getTargetFramework(project)`. Each provider keeps a private
`states` map keyed by `manifestPath`. To add an ecosystem, implement this interface and add the
provider to the array in `extension.ts`, plus registry/preview/OSV ecosystem branches.

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
  vsix ships `out/`, `media/`, `node_modules/jsonc-parser`, README, LICENSE.
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
