/**
 * Classify how risky a version bump is from the semver distance between two versions.
 * Deliberately tolerant of NuGet 4-part versions and prerelease suffixes.
 */

export type BumpRisk = 'major' | 'minor' | 'patch' | 'prerelease' | 'unknown';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** NuGet revision (4th part), 0 when absent. */
  revision: number;
  pre?: string;
}

function parse(version: string): ParsedVersion | undefined {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/.exec(version.trim());
  if (!m) {
    return undefined;
  }
  return {
    major: parseInt(m[1], 10),
    minor: m[2] ? parseInt(m[2], 10) : 0,
    patch: m[3] ? parseInt(m[3], 10) : 0,
    revision: m[4] ? parseInt(m[4], 10) : 0,
    pre: m[5],
  };
}

/** The semver level that changes between `current` and `target` (direction-agnostic). */
export function bumpRisk(current: string, target: string): BumpRisk {
  const c = parse(current);
  const t = parse(target);
  if (!c || !t) {
    return 'unknown';
  }
  if (c.major !== t.major) {
    return 'major';
  }
  if (c.minor !== t.minor) {
    return 'minor';
  }
  if (c.patch !== t.patch || c.revision !== t.revision) {
    return 'patch';
  }
  return c.pre !== t.pre ? 'prerelease' : 'patch';
}

/** Short badge text for checklists and descriptions ('' for unknown). */
export function riskBadge(risk: BumpRisk): string {
  switch (risk) {
    case 'major':
      return '⚠ major';
    case 'minor':
      return 'minor';
    case 'patch':
      return 'patch';
    case 'prerelease':
      return 'pre-release';
    default:
      return '';
  }
}

/** Longer human label used in the preview panel. */
export function riskLabel(risk: BumpRisk): string {
  switch (risk) {
    case 'major':
      return 'major update — potentially breaking';
    case 'minor':
      return 'minor update';
    case 'patch':
      return 'patch update';
    case 'prerelease':
      return 'pre-release change';
    default:
      return '';
  }
}
