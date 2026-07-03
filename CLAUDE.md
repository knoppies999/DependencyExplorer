# CLAUDE.md

VS Code extension: full npm/pnpm/NuGet dependency tree (direct + transitive) with OSV.dev
vulnerability flags and in-place update/override to fix them. Version lists + preview diffs resolve
the project's own custom feeds (`.npmrc` / `NuGet.config`, incl. auth). TypeScript → `out/` via `tsc`.

**Read [ARCHITECTURE.md](ARCHITECTURE.md) before non-trivial work** — it has the module map, domain
invariants, testing approach, and packaging/publishing steps.

## Must-know environment facts (these waste time if forgotten)

- **Node is not on PATH.** Prefix PowerShell with `$env:Path = "$env:ProgramFiles\nodejs;$env:Path";`
  (Bash: `export PATH="/c/Program Files/nodejs:$PATH"`). `dotnet` IS on PATH.
- **PowerShell cwd drifts** — `Set-Location "C:\Dev stuff\Copilot\DependencyExtension"` before build.
- **Bash tool is minimal git-bash**: `cat`/`grep`/`cp`/`ls`/`head`/`find` are often missing. Use
  Read/Glob/Grep or PowerShell. For `git commit`, use `-F <msgfile>` (heredoc `cat` fails).
- **Test workspace is a separate, non-repo folder**: `C:\Dev stuff\Copilot\DependencyTestWorkspace`
  (2 npm + 2 classic .NET + a `cpm-solution/`). Open *that* in the Extension Dev Host to test.
- **Tests are hand-rolled node scripts in the session scratchpad** (gone in a fresh chat) that mock
  `vscode`. Recreate from the pattern in ARCHITECTURE.md §8. Compile first: `npm run compile`.

## Build / package

`npm run compile` · `npx --yes @vscode/vsce package` → `.vsix`. Publisher `RuanduPlessis`, repo
`github.com/knoppies999/DependencyExplorer`, Marketplace upload via web UI or `vsce publish -p <PAT>`.

## Don't regress

- `services/vulnClosure.ts` must stay reverse-reachability (cycle-safe). The old DFS+memo+cycle-cut
  dropped the vulnerability warning on intermediate transitive nodes — see ARCHITECTURE.md §4.
- All manifest text edits go through the pure functions in `services/manifestEditor.ts` (unit-tested).
- npm resolution must use node_modules walk-up (`buildNpmGraph` in `providers/npmGraph.ts`), not naive
  name lookup. Both lockfiles feed a common `ResolvedGraph` (`providers/resolvedGraph.ts`); the pnpm
  parser is `providers/pnpmGraph.ts` (v6 + v9). `NpmProvider` is just an adapter over the graph.
- Feed resolution (`services/feedConfig.ts`) is `vscode`-free on purpose so it stays unit-testable;
  pnpm transitive overrides go in the **workspace-root** `package.json` under `pnpm.overrides`.
- "Fix all vulnerabilities" (`fixAllVulnerabilities` in `commands.ts`) picks the **nearest safe
  version** via `services/fixPlanner.ts` + OSV, reusing `applyToProject` (direct→update,
  transitive→pin). It's intentionally **resolver-free and re-runnable** — don't add tree re-resolution
  to make transitive fixes "smarter"; the re-run-after-install loop is the design.
