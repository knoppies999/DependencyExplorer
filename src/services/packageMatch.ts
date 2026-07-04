/**
 * Pure package-name matching for the "always update to latest" list. Kept `vscode`-free so it can
 * be unit-tested. Matching is case-insensitive; a `*` in a pattern is a wildcard matching any
 * sequence of characters (e.g. `@myorg/*` matches every package in that scope). Blank patterns are
 * ignored.
 */
export function matchesAnyPattern(name: string, patterns: string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) {
      return false;
    }
    if (!pattern.includes('*')) {
      return pattern === lower;
    }
    return patternToRegExp(pattern).test(lower);
  });
}

function patternToRegExp(pattern: string): RegExp {
  // Escape every regex metacharacter except `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
