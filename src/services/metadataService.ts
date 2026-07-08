import { Ecosystem } from '../types';
import { compareVersionsDesc, isPrerelease } from './registryService';
import {
  getNugetServiceEndpoints,
  joinUrl,
  NugetServiceEndpoints,
  resolveNpmFeed,
  resolveNugetSources,
} from './feedConfig';

/**
 * Best-effort package metadata that isn't needed to resolve versions but enriches the UI:
 * deprecation flags per version, and repository / release-notes / homepage links. Fetched lazily
 * (first time a node renders), cached for the session, and never allowed to block or fail a flow —
 * a package with no metadata simply shows less. Deliberately free of any `vscode` import.
 */

export interface PackageMetadata {
  /** Normalized https URL of the source repository, when the registry declares one. */
  repositoryUrl?: string;
  /** Best link for release notes: GitHub releases page when hosted there, else repo/project URL. */
  releaseNotesUrl?: string;
  homepage?: string;
  /** Public registry page (npmjs.com / nuget.org) — only set when the package's feed is public. */
  registryPageUrl?: string;
  /** Latest published version reported by the feed. */
  latest?: string;
  /** Deprecated versions → deprecation message ('' when the registry gives no message). */
  deprecated: Map<string, string>;
}

const METADATA_TIMEOUT_MS = 15_000;

/** Session caches: `resolved` holds finished lookups (undefined = failed; don't retry). */
const resolved = new Map<string, PackageMetadata | undefined>();
const inflight = new Map<string, Promise<PackageMetadata | undefined>>();

function cacheKey(ecosystem: Ecosystem, name: string): string {
  // NuGet ids are case-insensitive; npm names are canonical lowercase already.
  return `${ecosystem}:${name.toLowerCase()}`;
}

/** Cached metadata, if a lookup for this package has already completed (even unsuccessfully). */
export function getCachedMetadata(ecosystem: Ecosystem, name: string): PackageMetadata | undefined {
  return resolved.get(cacheKey(ecosystem, name));
}

/** Whether a lookup for this package has completed (used to avoid re-kicking failed fetches). */
export function hasMetadata(ecosystem: Ecosystem, name: string): boolean {
  return resolved.has(cacheKey(ecosystem, name));
}

/**
 * Fetch (or return cached) metadata for a package. Never rejects — resolves undefined when the
 * feed doesn't offer metadata or can't be reached. Concurrent calls share one request.
 */
export function fetchPackageMetadata(
  ecosystem: Ecosystem,
  name: string,
  projectDir: string
): Promise<PackageMetadata | undefined> {
  const key = cacheKey(ecosystem, name);
  if (resolved.has(key)) {
    return Promise.resolve(resolved.get(key));
  }
  let pending = inflight.get(key);
  if (!pending) {
    const signal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    pending = (ecosystem === 'npm' ? loadNpm(name, projectDir, signal) : loadNuget(name, projectDir, signal))
      .catch(() => undefined)
      .then((meta) => {
        resolved.set(key, meta);
        inflight.delete(key);
        return meta;
      });
    inflight.set(key, pending);
  }
  return pending;
}

/* ---------------------------------- npm ---------------------------------- */

async function loadNpm(
  name: string,
  projectDir: string,
  signal: AbortSignal
): Promise<PackageMetadata | undefined> {
  const feed = resolveNpmFeed(name, projectDir);
  const meta: PackageMetadata = { deprecated: new Map() };
  let gotAnything = false;

  // Abbreviated packument: small, and carries the per-version `deprecated` field.
  const res = await fetch(joinUrl(feed.baseUrl, encodeURIComponent(name)), {
    headers: { ...feed.headers, accept: 'application/vnd.npm.install-v1+json' },
    signal,
  });
  if (res.ok) {
    gotAnything = true;
    const data = (await res.json()) as {
      'dist-tags'?: Record<string, string>;
      versions?: Record<string, { deprecated?: string | boolean }>;
    };
    meta.latest = data['dist-tags']?.latest;
    for (const [version, info] of Object.entries(data.versions ?? {})) {
      if (info?.deprecated) {
        meta.deprecated.set(version, typeof info.deprecated === 'string' ? info.deprecated : '');
      }
    }
  }

  // Repository/homepage live only in full version docs; `<name>/latest` is the cheapest of those.
  try {
    const vres = await fetch(joinUrl(feed.baseUrl, `${encodeURIComponent(name)}/latest`), {
      headers: feed.headers,
      signal,
    });
    if (vres.ok) {
      gotAnything = true;
      const v = (await vres.json()) as {
        repository?: string | { url?: string };
        homepage?: string;
      };
      meta.repositoryUrl = normalizeRepoUrl(
        typeof v.repository === 'string' ? v.repository : v.repository?.url
      );
      meta.homepage = typeof v.homepage === 'string' ? v.homepage : undefined;
    }
  } catch {
    // Some private registries don't support the /latest route — links just stay empty.
  }

  if (!gotAnything) {
    return undefined;
  }
  if (/registry\.npmjs\.org/i.test(feed.baseUrl)) {
    meta.registryPageUrl = `https://www.npmjs.com/package/${name}`;
  }
  finalizeLinks(meta);
  return meta;
}

/** Turn the many shapes of npm `repository` values into a plain https URL (or undefined). */
export function normalizeRepoUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  let u = url.trim();
  const shorthand = /^(github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(u);
  if (shorthand) {
    return `https://github.com/${trimGitSuffix(shorthand[2])}`;
  }
  if (u.startsWith('gitlab:')) {
    return `https://gitlab.com/${trimGitSuffix(u.slice(7))}`;
  }
  if (u.startsWith('bitbucket:')) {
    return `https://bitbucket.org/${trimGitSuffix(u.slice(10))}`;
  }
  u = u.replace(/^git\+/, '');
  const ssh = /^(?:git@|ssh:\/\/(?:git@)?)([^:/]+)[:/](.+)$/.exec(u);
  if (ssh) {
    u = `https://${ssh[1]}/${ssh[2]}`;
  }
  u = u.replace(/^git:\/\//, 'https://');
  u = trimGitSuffix(u);
  return /^https?:\/\//i.test(u) ? u : undefined;
}

function trimGitSuffix(u: string): string {
  return u.replace(/\.git(#[^]*)?$/, '').replace(/\/+$/, '');
}

/* --------------------------------- NuGet --------------------------------- */

interface RegistrationLeaf {
  catalogEntry?: {
    version?: string;
    listed?: boolean;
    projectUrl?: string;
    deprecation?: { message?: string; reasons?: string[] };
  };
}

async function loadNuget(
  name: string,
  projectDir: string,
  signal: AbortSignal
): Promise<PackageMetadata | undefined> {
  const meta: PackageMetadata = { deprecated: new Map() };
  const id = name.toLowerCase();
  const sources = resolveNugetSources(name, projectDir);
  let found = false;
  for (const source of sources) {
    try {
      const ep = await getNugetServiceEndpoints(source, signal);
      if (!ep) {
        continue;
      }
      if (ep.registrationsBase && (await metaFromRegistrations(id, ep, meta, signal))) {
        found = true;
        break;
      }
      if (ep.flatContainer && (await metaFromNuspec(id, ep, meta, signal))) {
        found = true;
        break;
      }
    } catch {
      if (signal.aborted) {
        throw new Error('metadata lookup timed out');
      }
      // Try the next source.
    }
  }
  if (!found) {
    return undefined;
  }
  if (sources.some((s) => /api\.nuget\.org/i.test(s.indexUrl))) {
    meta.registryPageUrl = `https://www.nuget.org/packages/${name}`;
  }
  finalizeLinks(meta);
  return meta;
}

/**
 * Read deprecation info (nuget.org exposes it on registration leaves) and the newest listed
 * entry's projectUrl. Returns false when the package isn't on this source.
 */
async function metaFromRegistrations(
  id: string,
  ep: NugetServiceEndpoints,
  meta: PackageMetadata,
  signal: AbortSignal
): Promise<boolean> {
  const res = await fetch(joinUrl(ep.registrationsBase!, `${id}/index.json`), {
    headers: { ...ep.headers, accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    return false;
  }
  const index = (await res.json()) as {
    items?: { '@id'?: string; items?: RegistrationLeaf[] }[];
  };
  let newest: { version: string; projectUrl?: string } | undefined;
  const pages = index.items ?? [];
  // Cap remote page fetches so a package with a huge history can't stall the lookup.
  let remotePagesFetched = 0;
  for (const page of pages) {
    let leaves = page.items;
    if (!leaves && page['@id'] && remotePagesFetched < 10) {
      remotePagesFetched++;
      const pageRes = await fetch(page['@id'], {
        headers: { ...ep.headers, accept: 'application/json' },
        signal,
      });
      if (!pageRes.ok) {
        continue;
      }
      leaves = ((await pageRes.json()) as { items?: RegistrationLeaf[] }).items;
    }
    for (const leaf of leaves ?? []) {
      const entry = leaf.catalogEntry;
      if (!entry?.version) {
        continue;
      }
      if (entry.deprecation) {
        meta.deprecated.set(
          entry.version,
          entry.deprecation.message ?? (entry.deprecation.reasons ?? []).join(', ')
        );
      }
      if (
        entry.listed !== false &&
        !isPrerelease(entry.version) &&
        (!newest || compareVersionsDesc(entry.version, newest.version) < 0)
      ) {
        newest = { version: entry.version, projectUrl: entry.projectUrl };
      }
    }
  }
  if (!newest) {
    return false;
  }
  meta.latest = newest.version;
  meta.homepage = newest.projectUrl || undefined;
  return true;
}

/** Fallback for flat-container-only feeds: read links from the newest version's nuspec. */
async function metaFromNuspec(
  id: string,
  ep: NugetServiceEndpoints,
  meta: PackageMetadata,
  signal: AbortSignal
): Promise<boolean> {
  const listRes = await fetch(joinUrl(ep.flatContainer!, `${id}/index.json`), {
    headers: ep.headers,
    signal,
  });
  if (!listRes.ok) {
    return false;
  }
  const versions = ((await listRes.json()) as { versions?: string[] }).versions ?? [];
  if (versions.length === 0) {
    return false;
  }
  const sorted = [...versions].sort(compareVersionsDesc);
  const latest = sorted.find((v) => !isPrerelease(v)) ?? sorted[0];
  meta.latest = latest;

  const nuspecRes = await fetch(joinUrl(ep.flatContainer!, `${id}/${latest.toLowerCase()}/${id}.nuspec`), {
    headers: ep.headers,
    signal,
  });
  if (nuspecRes.ok) {
    const xml = await nuspecRes.text();
    meta.homepage = /<projectUrl>\s*([^<\s][^<]*?)\s*<\/projectUrl>/i.exec(xml)?.[1];
    meta.repositoryUrl = normalizeRepoUrl(
      /<repository\b[^>]*\burl\s*=\s*"([^"]+)"/i.exec(xml)?.[1]
    );
  }
  return true;
}

/* --------------------------------- shared -------------------------------- */

/** Derive the release-notes link: GitHub releases page when possible, else repo, else homepage. */
function finalizeLinks(meta: PackageMetadata): void {
  if (!meta.repositoryUrl && meta.homepage && /^https:\/\/github\.com\//i.test(meta.homepage)) {
    meta.repositoryUrl = trimGitSuffix(meta.homepage);
  }
  const gh = meta.repositoryUrl
    ? /^https:\/\/github\.com\/[^/]+\/[^/]+/i.exec(meta.repositoryUrl)
    : null;
  meta.releaseNotesUrl = gh ? `${gh[0]}/releases` : meta.repositoryUrl ?? undefined;
}

/** Test hook: clear the session caches. */
export function _resetMetadataCache(): void {
  resolved.clear();
  inflight.clear();
}
