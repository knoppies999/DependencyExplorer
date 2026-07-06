import { Ecosystem } from '../types';
import {
  getNugetServiceEndpoints,
  joinUrl,
  NugetServiceEndpoints,
  resolveNpmFeed,
  resolveNugetSources,
} from './feedConfig';

export interface VersionList {
  /** All published versions, newest first. */
  versions: string[];
  latest?: string;
}

/** Default per-package budget for resolving versions before we give up and move on. */
export const DEFAULT_VERSION_TIMEOUT_MS = 30_000;

/**
 * List published versions for a package, honoring the feeds configured for `projectDir`
 * (custom npm registry / private NuGet sources). Falls back to the public registries when the
 * project has no relevant `.npmrc` / `NuGet.config`.
 *
 * The whole lookup (across every configured source and registration/OData page) shares a single
 * `timeoutMs` budget; when it elapses the in-flight requests are aborted and a timeout error is
 * thrown, so a slow or unreachable feed can't stall a bulk operation.
 */
export async function fetchVersions(
  ecosystem: Ecosystem,
  name: string,
  projectDir: string,
  timeoutMs: number = DEFAULT_VERSION_TIMEOUT_MS
): Promise<VersionList> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    if (ecosystem === 'npm') {
      const feed = resolveNpmFeed(name, projectDir);
      const res = await fetch(joinUrl(feed.baseUrl, encodeURIComponent(name)), {
        headers: { ...feed.headers, accept: 'application/vnd.npm.install-v1+json' },
        signal,
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

    return await fetchNugetVersions(name, projectDir, signal);
  } catch (err) {
    if (signal.aborted) {
      throw new Error(`Timed out resolving versions for ${name} after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
}

async function fetchNugetVersions(
  name: string,
  projectDir: string,
  signal: AbortSignal
): Promise<VersionList> {
  const sources = resolveNugetSources(name, projectDir);
  const all = new Set<string>();
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const endpoints = await getNugetServiceEndpoints(source, signal);
      if (!endpoints) {
        errors.push(`${source.key}: service index unreachable`);
        continue;
      }
      const versions = await listVersions(name, endpoints, signal);
      for (const v of versions ?? []) {
        all.add(v);
      }
    } catch (err) {
      if (signal.aborted) {
        throw err; // let the timeout surface as a single, clear error
      }
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

interface RegistrationPage {
  '@id'?: string;
  items?: { catalogEntry?: { version?: string; listed?: boolean } }[];
}

/**
 * List versions from a source's best available endpoint: the flat container if present, otherwise
 * the registrations index (GitHub Packages et al.), otherwise a legacy V2 OData feed. Returns
 * undefined when the package isn't published on the source; throws on a hard feed error.
 */
async function listVersions(
  name: string,
  ep: NugetServiceEndpoints,
  signal: AbortSignal
): Promise<string[] | undefined> {
  const id = name.toLowerCase();
  if (ep.flatContainer) {
    const res = await fetch(joinUrl(ep.flatContainer, `${id}/index.json`), {
      headers: ep.headers,
      signal,
    });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(`flat container ${res.status}`);
    }
    return (await res.json() as { versions?: string[] }).versions ?? [];
  }
  if (ep.registrationsBase) {
    return versionsFromRegistrations(id, ep, signal);
  }
  if (ep.v2Base) {
    return versionsFromV2(name, ep, signal);
  }
  return undefined;
}

async function versionsFromRegistrations(
  id: string,
  ep: NugetServiceEndpoints,
  signal: AbortSignal
): Promise<string[] | undefined> {
  const res = await fetch(joinUrl(ep.registrationsBase!, `${id}/index.json`), {
    headers: { ...ep.headers, accept: 'application/json' },
    signal,
  });
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`registrations ${res.status}`);
  }
  const index = (await res.json()) as { items?: RegistrationPage[] };
  const versions: string[] = [];
  for (const page of index.items ?? []) {
    let leaves = page.items;
    if (!leaves && page['@id']) {
      // Large registrations paginate: the index lists page URLs to fetch on demand.
      const pageRes = await fetch(page['@id'], {
        headers: { ...ep.headers, accept: 'application/json' },
        signal,
      });
      if (!pageRes.ok) {
        continue;
      }
      leaves = ((await pageRes.json()) as RegistrationPage).items;
    }
    for (const leaf of leaves ?? []) {
      const entry = leaf.catalogEntry;
      if (entry?.version && entry.listed !== false) {
        versions.push(entry.version);
      }
    }
  }
  return versions.length > 0 ? versions : undefined;
}

async function versionsFromV2(
  name: string,
  ep: NugetServiceEndpoints,
  signal: AbortSignal
): Promise<string[] | undefined> {
  const versions: string[] = [];
  let url: string | undefined = joinUrl(
    ep.v2Base!,
    `FindPackagesById()?id='${encodeURIComponent(name)}'&semVerLevel=2.0.0`
  );
  for (let page = 0; url && page < 10; page++) {
    const res: Response = await fetch(url, {
      headers: { ...ep.headers, accept: 'application/atom+xml' },
      signal,
    });
    if (res.status === 404) {
      break;
    }
    if (!res.ok) {
      throw new Error(`v2 feed ${res.status}`);
    }
    const xml = await res.text();
    // Prefer the normalized version when the feed reports one; fall back to the raw version.
    let matches = [...xml.matchAll(/<d:NormalizedVersion>([^<]+)<\/d:NormalizedVersion>/gi)];
    if (matches.length === 0) {
      matches = [...xml.matchAll(/<d:Version>([^<]+)<\/d:Version>/gi)];
    }
    for (const m of matches) {
      versions.push(m[1].trim());
    }
    url = /<link\b[^>]*\brel="next"[^>]*\bhref="([^"]+)"/i.exec(xml)?.[1];
  }
  const unique = [...new Set(versions)];
  return unique.length > 0 ? unique : undefined;
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
