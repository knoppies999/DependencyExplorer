/**
 * Post-install failure analysis (vscode-free so it stays unit-testable).
 *
 * When a fix bumps a package to its nearest safe version, that version can violate a *peer*
 * dependency somewhere else in the tree — npm then aborts the install with `ERESOLVE` and refuses to
 * write anything. We can't resolve peers ourselves (the extension is deliberately resolver-free), but
 * we can recognise this specific failure and offer the user npm/pnpm's documented escape hatch.
 */

/** True when install output is an npm/pnpm peer-dependency resolution conflict (ERESOLVE). */
export function isPeerConflict(output: string): boolean {
  return /ERESOLVE|could not resolve dependency|conflicting peer dependenc/i.test(output);
}

/**
 * The flag that tells the given install command to accept a peer-incompatible resolution, or
 * undefined for commands that have no such concept (e.g. `dotnet restore`).
 */
export function peerDepsRetryFlag(command: string): string | undefined {
  if (/\bpnpm\b/.test(command)) {
    return '--no-strict-peer-dependencies';
  }
  if (/\bnpm\b/.test(command)) {
    return '--legacy-peer-deps';
  }
  return undefined;
}
