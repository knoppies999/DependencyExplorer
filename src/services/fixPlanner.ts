import { Ecosystem, Project } from '../types';

/** One planned "fix all" change: bump `name` from `currentVersion` to `targetVersion`. */
export interface FixPlanItem {
  project: Project;
  ecosystem: Ecosystem;
  name: string;
  isDirect: boolean;
  currentVersion: string;
  /** Nearest safe version to apply, or undefined when no non-vulnerable version was found. */
  targetVersion?: string;
}

/**
 * The smallest version *above* `current` that `isSafe` accepts, walking newest-last.
 * Stable versions are preferred; a prerelease is only returned if no stable candidate is safe.
 * `versionsDesc` is the registry list newest-first (as `fetchVersions` returns it); `compare`
 * orders two versions descending (newest first), e.g. `compareVersionsDesc`.
 */
export function nearestSafeVersion(
  versionsDesc: string[],
  current: string,
  isSafe: (version: string) => boolean,
  compare: (a: string, b: string) => number,
  isPrerelease: (version: string) => boolean
): string | undefined {
  // Candidates strictly newer than current, ascending (nearest first).
  const ascending = versionsDesc
    .filter((v) => compare(v, current) < 0) // v newer than current
    .sort((a, b) => compare(b, a)); // ascending

  const stable = ascending.filter((v) => !isPrerelease(v));
  return stable.find(isSafe) ?? ascending.find(isSafe);
}
