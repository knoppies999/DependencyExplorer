# Dependency Explorer

A VS Code extension that shows the **full dependency tree — including transitive dependencies —** for npm and NuGet projects, flags packages with known vulnerabilities, and lets you fix them by updating a direct dependency or overriding/pinning a transitive one.

## Features

- **Dependencies view** in the activity bar: **every** npm and NuGet project in the workspace is listed as its own top-level node (monorepos and multi-project solutions are fully supported), with direct dependencies underneath and transitive dependencies collapsed one level deeper, expandable as far as you like.
- **Vulnerability flags** via the free [OSV.dev](https://osv.dev) API:
  - red warning icon = this package version has known vulnerabilities (IDs are linked in the tooltip),
  - yellow warning icon = something deeper in this package's subtree is vulnerable, so you can trace which direct dependency pulls it in.
- **Update Version…** (↑ icon on direct dependencies): pick a version from the registry and the manifest is edited in place, preserving your range style (`^` / `~` / exact).
- **Override / Pin Version…** (📌 icon on transitive dependencies):
  - npm: adds the package to the [`"overrides"`](https://docs.npmjs.com/cli/configuring-npm/package-json#overrides) field of `package.json`,
  - NuGet: adds a direct `<PackageReference>` pin to the `.csproj` (NuGet's *direct-wins* rule), with Central Package Management (`Directory.Packages.props`) handled automatically.
- **Preview before you apply.** Choosing a version opens a diff panel showing how that version's *own* dependency requirements differ from your current version — which transitive dependencies get **added**, **removed**, **changed**, or stay the same — pulled live from the registry. Nothing is written until you click **Apply**. (For NuGet, the diff is read for your project's target framework.)
- **Bump a duplicate package across every project that uses it.** When a package (often a vulnerable transitive one like `qs`) is shared by several projects, you can fix it once:
  - click **Update** / **Override** on any occurrence and choose *Apply to all N projects*, or
  - use the **Update Package Across All Projects…** button in the view title bar to pick from a list of shared packages.
  - Each project is fixed the right way: it's a direct dependency there → the version is updated; it's transitive there → an override/pin is added.
- After an edit, the extension offers to run `npm install` / `dotnet restore` (one terminal per affected project); the tree refreshes automatically when the lock/assets files change.

## How it reads the tree

| Ecosystem | Source of truth | Requirement |
| --- | --- | --- |
| npm | `package-lock.json` (v2/v3 `packages` map, with real node_modules-style resolution) | run `npm install` once (npm 7+) |
| NuGet | `obj/project.assets.json` | run `dotnet restore` once |

These are the *resolved* graphs, so versions match exactly what your build uses.

## Central Package Management (NuGet)

[Central Package Management](https://learn.microsoft.com/nuget/consume-packages/central-package-management)
(CPM) — where package versions live in a `Directory.Packages.props` file instead of on each
`<PackageReference>` — is fully supported. The extension discovers the nearest
`Directory.Packages.props` by walking up from the project folder and edits the right file
automatically:

| Action | Classic project | CPM project |
| --- | --- | --- |
| **Update** a direct dependency | edits `Version="…"` on the `<PackageReference>` in the `.csproj` | edits the `<PackageVersion>` in `Directory.Packages.props` (or a `VersionOverride` on the reference if one exists) |
| **Override** a transitive dependency | adds a versioned `<PackageReference>` pin to the `.csproj` | adds a `<PackageVersion>` to `Directory.Packages.props`; if [transitive pinning](https://learn.microsoft.com/nuget/consume-packages/central-package-management#transitive-pinning) is **off**, it also adds a versionless `<PackageReference>` to force the pin |

Because a CPM version is shared, updating it fixes every project under that props file at once —
which pairs naturally with the "bump across all projects" feature.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press **F5** in VS Code to launch an Extension Development Host, then open any folder containing an npm or .NET project.

To package a `.vsix` for installation:

```bash
npx @vscode/vsce package
```

then install it via *Extensions: Install from VSIX…*.

## Project layout

- [`src/extension.ts`](src/extension.ts) — activation, tree view registration, file watchers
- [`src/tree/dependencyTree.ts`](src/tree/dependencyTree.ts) — `TreeDataProvider` (lazy expansion, icons, tooltips)
- [`src/providers/npmProvider.ts`](src/providers/npmProvider.ts) — lockfile parsing + node_modules-style resolution
- [`src/providers/nugetProvider.ts`](src/providers/nugetProvider.ts) — `project.assets.json` parsing
- [`src/services/vulnClosure.ts`](src/services/vulnClosure.ts) — cycle-safe "subtree contains a vulnerability" reachability
- [`src/services/osvService.ts`](src/services/osvService.ts) — batched OSV.dev vulnerability queries (cached per session)
- [`src/services/registryService.ts`](src/services/registryService.ts) — version lists from registry.npmjs.org / api.nuget.org
- [`src/services/manifestEditor.ts`](src/services/manifestEditor.ts) — pure text edits for `package.json`, `.csproj`, `Directory.Packages.props`
- [`src/services/previewService.ts`](src/services/previewService.ts) — fetches a version's declared dependencies and diffs current vs target
- [`src/ui/previewPanel.ts`](src/ui/previewPanel.ts) — webview showing the transitive-dependency impact, with Apply / Cancel
- [`src/commands.ts`](src/commands.ts) — update/override commands, preview + confirm, cross-project "apply to all", version quick-pick, install prompt

## Known limitations

- npm workspaces: packages inside a monorepo without their own `package-lock.json` show a "run npm install" hint; open the workspace root (where the lock lives) to see the full graph. npm `overrides` are only honoured by npm from the root `package.json`.
- NuGet multi-targeted projects show the first target framework's graph.
- Vulnerability severity levels are not fetched (only IDs, linked to osv.dev); circular references are shown once and marked *circular*.
