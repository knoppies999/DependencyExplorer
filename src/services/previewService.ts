import { Ecosystem } from '../types';
import {
  getNugetServiceEndpoints,
  joinUrl,
  NugetServiceEndpoints,
  resolveNpmFeed,
  resolveNugetSources,
} from './feedConfig';

export interface DepRequirement {
  name: string;
  /** Version range as the package declares it (npm semver range or NuGet version range). */
  range: string;
  optional?: boolean;
}

export type ChangeStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DepChange {
  name: string;
  current?: string;
  target?: string;
  optional?: boolean;
  status: ChangeStatus;
}

export interface BumpPreview {
  changes: DepChange[];
  /** NuGet only: which dependency group (target framework) the target deps came from. */
  framework?: string;
  /** True when the current version's dependencies could not be fetched (diff is target-only). */
  currentUnavailable: boolean;
}

/**
 * Compare the *declared* dependencies of a package at `currentVersion` vs `targetVersion`,
 * so the user can see what bumping does to its transitive dependencies before applying.
 */
export async function computeBumpPreview(
  ecosystem: Ecosystem,
  name: string,
  currentVersion: string,
  targetVersion: string,
  projectDir: string,
  targetFramework?: string
): Promise<BumpPreview> {
  if (ecosystem === 'npm') {
    const [current, target] = await Promise.all([
      safe(() => fetchNpmDeps(name, currentVersion, projectDir)),
      fetchNpmDeps(name, targetVersion, projectDir),
    ]);
    return {
      changes: diffDependencies(current ?? [], target),
      currentUnavailable: current === undefined,
    };
  }

  const [current, target] = await Promise.all([
    safe(() => fetchNugetDeps(name, currentVersion, projectDir, targetFramework)),
    fetchNugetDeps(name, targetVersion, projectDir, targetFramework),
  ]);
  return {
    changes: diffDependencies(current?.deps ?? [], target.deps),
    framework: target.framework,
    currentUnavailable: current === undefined,
  };
}

export function diffDependencies(current: DepRequirement[], target: DepRequirement[]): DepChange[] {
  const byCurrent = new Map(current.map((d) => [d.name.toLowerCase(), d]));
  const byTarget = new Map(target.map((d) => [d.name.toLowerCase(), d]));
  const keys = new Set([...byCurrent.keys(), ...byTarget.keys()]);

  const changes: DepChange[] = [];
  for (const key of keys) {
    const c = byCurrent.get(key);
    const t = byTarget.get(key);
    if (c && t) {
      changes.push({
        name: t.name,
        current: c.range,
        target: t.range,
        optional: t.optional,
        status: normalize(c.range) === normalize(t.range) ? 'unchanged' : 'changed',
      });
    } else if (t) {
      changes.push({ name: t.name, target: t.range, optional: t.optional, status: 'added' });
    } else if (c) {
      changes.push({ name: c.name, current: c.range, optional: c.optional, status: 'removed' });
    }
  }

  const order: Record<ChangeStatus, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 };
  return changes.sort(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name)
  );
}

/* ---------------------------------- npm ---------------------------------- */

async function fetchNpmDeps(
  name: string,
  version: string,
  projectDir: string
): Promise<DepRequirement[]> {
  const feed = resolveNpmFeed(name, projectDir);
  const res = await fetch(joinUrl(feed.baseUrl, `${name}/${version}`), { headers: feed.headers });
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${name}@${version}`);
  }
  const data = (await res.json()) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const seen = new Set<string>();
  const reqs: DepRequirement[] = [];
  for (const [n, r] of Object.entries(data.dependencies ?? {})) {
    seen.add(n);
    reqs.push({ name: n, range: r });
  }
  for (const [n, r] of Object.entries(data.optionalDependencies ?? {})) {
    if (!seen.has(n)) {
      reqs.push({ name: n, range: r, optional: true });
    }
  }
  return reqs;
}

/* --------------------------------- NuGet --------------------------------- */

async function fetchNugetDeps(
  name: string,
  version: string,
  projectDir: string,
  targetFramework?: string
): Promise<{ deps: DepRequirement[]; framework?: string }> {
  const id = name.toLowerCase();
  const ver = version.toLowerCase();
  const sources = resolveNugetSources(name, projectDir);
  const errors: string[] = [];
  for (const source of sources) {
    const ep = await getNugetServiceEndpoints(source);
    if (!ep) {
      continue;
    }
    try {
      if (ep.flatContainer) {
        const res = await fetch(joinUrl(ep.flatContainer, `${id}/${ver}/${id}.nuspec`), {
          headers: ep.headers,
        });
        if (res.status === 404) {
          continue;
        }
        if (!res.ok) {
          errors.push(`${source.key}: ${res.status}`);
          continue;
        }
        return parseNuspecDeps(await res.text(), targetFramework);
      }
      if (ep.registrationsBase) {
        // Feeds without a flat container (e.g. GitHub Packages) expose dependency groups on the
        // registration leaf instead of a downloadable nuspec.
        const deps = await depsFromRegistrations(id, version, ep, targetFramework);
        if (deps) {
          return deps;
        }
        continue;
      }
      // Legacy V2 feeds don't offer dependency metadata via a single call — skip for preview.
    } catch (err) {
      errors.push(`${source.key}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(
    `NuGet nuspec unavailable for ${name} ${version}${errors.length ? ` (${errors.join('; ')})` : ''}`
  );
}

interface RegistrationLeaf {
  catalogEntry?: {
    version?: string;
    dependencyGroups?: { targetFramework?: string; dependencies?: { id?: string; range?: string }[] }[];
  };
}

async function depsFromRegistrations(
  id: string,
  version: string,
  ep: NugetServiceEndpoints,
  targetFramework?: string
): Promise<{ deps: DepRequirement[]; framework?: string } | undefined> {
  const res = await fetch(joinUrl(ep.registrationsBase!, `${id}/index.json`), {
    headers: { ...ep.headers, accept: 'application/json' },
  });
  if (!res.ok) {
    return undefined;
  }
  const index = (await res.json()) as {
    items?: { '@id'?: string; items?: RegistrationLeaf[] }[];
  };
  const want = version.toLowerCase();
  for (const page of index.items ?? []) {
    let leaves = page.items;
    if (!leaves && page['@id']) {
      const pageRes = await fetch(page['@id'], { headers: { ...ep.headers, accept: 'application/json' } });
      if (!pageRes.ok) {
        continue;
      }
      leaves = ((await pageRes.json()) as { items?: RegistrationLeaf[] }).items;
    }
    for (const leaf of leaves ?? []) {
      const entry = leaf.catalogEntry;
      if (entry?.version?.toLowerCase() === want) {
        return selectRegistrationGroup(entry.dependencyGroups, targetFramework);
      }
    }
  }
  return undefined;
}

function selectRegistrationGroup(
  groups: { targetFramework?: string; dependencies?: { id?: string; range?: string }[] }[] | undefined,
  targetFramework?: string
): { deps: DepRequirement[]; framework?: string } {
  const mapped = (groups ?? []).map((g) => ({
    fw: g.targetFramework,
    deps: (g.dependencies ?? [])
      .filter((d) => d.id)
      .map((d) => ({ name: d.id!, range: d.range ?? '' })),
  }));
  if (mapped.length === 0) {
    return { deps: [] };
  }
  const want = targetFramework ? normalizeTfm(targetFramework) : undefined;
  const exact = want ? mapped.find((g) => g.fw && normalizeTfm(g.fw) === want) : undefined;
  const chosen = exact ?? mapped.find((g) => !g.fw) ?? mapped[0];
  return { deps: chosen.deps, framework: chosen.fw };
}

export function parseNuspecDeps(
  xml: string,
  targetFramework?: string
): { deps: DepRequirement[]; framework?: string } {
  const block = /<dependencies\b[^>]*>([\s\S]*?)<\/dependencies>/i.exec(xml);
  if (!block) {
    return { deps: [] };
  }
  const inner = block[1];

  const groups: { fw?: string; body: string }[] = [];
  const groupRegex = /<group\b([^>]*)>([\s\S]*?)<\/group>/gi;
  let m: RegExpExecArray | null;
  while ((m = groupRegex.exec(inner))) {
    const fw = /targetFramework\s*=\s*"([^"]*)"/i.exec(m[1])?.[1];
    groups.push({ fw, body: m[2] });
  }

  if (groups.length === 0) {
    // Legacy nuspec: flat <dependency> list with no framework grouping.
    return { deps: parseDependencyTags(inner) };
  }

  const chosen = pickGroup(groups, targetFramework);
  return { deps: parseDependencyTags(chosen.body), framework: chosen.fw };
}

function pickGroup(
  groups: { fw?: string; body: string }[],
  targetFramework?: string
): { fw?: string; body: string } {
  const want = targetFramework ? normalizeTfm(targetFramework) : undefined;
  if (want) {
    const exact = groups.find((g) => g.fw && normalizeTfm(g.fw) === want);
    if (exact) {
      return exact;
    }
  }
  // Prefer a framework-agnostic group, else fall back to the first declared group.
  return groups.find((g) => !g.fw) ?? groups[0];
}

function parseDependencyTags(body: string): DepRequirement[] {
  const deps: DepRequirement[] = [];
  const depRegex = /<dependency\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = depRegex.exec(body))) {
    const attrs = m[1];
    const id = /\bid\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (!id) {
      continue;
    }
    const version = /\bversion\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
    deps.push({ name: id, range: version });
  }
  return deps;
}

function normalizeTfm(tfm: string): string {
  return tfm.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* --------------------------------- shared -------------------------------- */

function normalize(range: string): string {
  return range.trim();
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
