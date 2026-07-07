// .NET Aspire helpers, deliberately free of any `vscode` import so they can be unit-tested under
// plain node (like feedConfig / registryService). Covers what counts as a first-party Aspire
// package and the common target-framework choices offered when bumping .NET.

/** The MSBuild SDK an Aspire AppHost imports (`<Sdk Name="Aspire.AppHost.Sdk" Version="…"/>`). */
export const ASPIRE_SDK_NAME = 'Aspire.AppHost.Sdk';

/**
 * The package whose published versions drive the Aspire version picker. `Aspire.AppHost.Sdk` is on
 * nuget.org and its release train matches the rest of the first-party `Aspire.*` packages, which
 * ship in lockstep — so one chosen version applies cleanly to the SDK and every `Aspire.*` package.
 */
export const ASPIRE_VERSION_REF = 'Aspire.AppHost.Sdk';

/**
 * True for a first-party .NET Aspire package (`Aspire.Hosting.AppHost`, `Aspire.Npgsql`, …). Only
 * the `Aspire.` prefix counts: community packages such as `CommunityToolkit.Aspire.*` version
 * independently of the core release, so they are intentionally excluded.
 */
export function isAspirePackage(name: string): boolean {
  return /^Aspire\./i.test(name);
}

/** Target frameworks offered by default in the .NET version picker, newest first. */
const COMMON_TFMS = ['net10.0', 'net9.0', 'net8.0'];

/**
 * Build the .NET version options: the projects' current framework(s) first (so the currently
 * targeted version is easy to re-pick or recognise), then the common `netX.0` choices, deduped and
 * case-insensitively. `current` is every distinct framework seen across the chosen scope.
 */
export function targetFrameworkOptions(current: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tfm of [...current, ...COMMON_TFMS]) {
    const key = tfm.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(tfm.trim());
  }
  return out;
}
