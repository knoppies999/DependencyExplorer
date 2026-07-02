import { Ecosystem } from '../types';

export interface VersionList {
  /** All published versions, newest first. */
  versions: string[];
  latest?: string;
}

export async function fetchVersions(ecosystem: Ecosystem, name: string): Promise<VersionList> {
  if (ecosystem === 'npm') {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
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

  const res = await fetch(
    `https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`
  );
  if (!res.ok) {
    throw new Error(`NuGet registry returned ${res.status} for ${name}`);
  }
  const data = (await res.json()) as { versions?: string[] };
  const versions = (data.versions ?? []).sort(compareVersionsDesc);
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
