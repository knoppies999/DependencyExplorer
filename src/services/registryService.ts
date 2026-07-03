import { Ecosystem } from '../types';
import {
  getNugetFlatContainer,
  joinUrl,
  resolveNpmFeed,
  resolveNugetSources,
} from './feedConfig';

export interface VersionList {
  /** All published versions, newest first. */
  versions: string[];
  latest?: string;
}

/**
 * List published versions for a package, honoring the feeds configured for `projectDir`
 * (custom npm registry / private NuGet sources). Falls back to the public registries when the
 * project has no relevant `.npmrc` / `NuGet.config`.
 */
export async function fetchVersions(
  ecosystem: Ecosystem,
  name: string,
  projectDir: string
): Promise<VersionList> {
  if (ecosystem === 'npm') {
    const feed = resolveNpmFeed(name, projectDir);
    const res = await fetch(joinUrl(feed.baseUrl, encodeURIComponent(name)), {
      headers: { ...feed.headers, accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) {
      throw new Error(`npm registry returned ${res.status} for ${name}`);
    }
    const data = (await res.json()) as {
      'dist-tags'?: Record<string, string>;
      versions?: Record<string, unknown>;
    };
    const versions = Object.keys(data.versions ?? {}).sort(compareVersionsDesc);
    return { versions, latest: data['dist-tags']?.latest };
  }

  return fetchNugetVersions(name, projectDir);
}

async function fetchNugetVersions(name: string, projectDir: string): Promise<VersionList> {
  const sources = resolveNugetSources(name, projectDir);
  const all = new Set<string>();
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const flat = await getNugetFlatContainer(source);
      if (!flat) {
        continue;
      }
      const res = await fetch(joinUrl(flat.base, `${name.toLowerCase()}/index.json`), {
        headers: flat.headers,
      });
      if (res.status === 404) {
        continue; // package simply isn't on this feed
      }
      if (!res.ok) {
        errors.push(`${source.key}: ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { versions?: string[] };
      for (const v of data.versions ?? []) {
        all.add(v);
      }
    } catch (err) {
      errors.push(`${source.key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (all.size === 0) {
    if (errors.length > 0) {
      throw new Error(`NuGet feed error for ${name} (${errors.join('; ')})`);
    }
    throw new Error(`No versions of ${name} found on the configured NuGet sources`);
  }
  const versions = [...all].sort(compareVersionsDesc);
  const latest = versions.find((v) => !isPrerelease(v)) ?? versions[0];
  return { versions, latest };
}

export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/** Lightweight semver-ish comparison, newest first. Handles 4-part NuGet versions. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 4; i++) {
    const diff = (pb.parts[i] ?? 0) - (pa.parts[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  // Same core version: stable releases sort above prereleases.
  if (pa.pre === undefined && pb.pre !== undefined) return -1;
  if (pa.pre !== undefined && pb.pre === undefined) return 1;
  if (pa.pre !== undefined && pb.pre !== undefined) {
    return pb.pre.localeCompare(pa.pre);
  }
  return 0;
}

function parseVersion(v: string): { parts: number[]; pre?: string } {
  const dash = v.indexOf('-');
  const core = dash === -1 ? v : v.slice(0, dash);
  const pre = dash === -1 ? undefined : v.slice(dash + 1);
  const parts = core.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return { parts, pre };
}
