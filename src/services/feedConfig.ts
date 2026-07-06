import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Resolves the package feeds a project actually uses — from its own `.npmrc` (npm/pnpm) and
 * `NuGet.config` (NuGet) — so version lists and preview diffs read from private/authenticated
 * feeds instead of always hitting the public registries. Deliberately free of any `vscode`
 * import so it can be unit-tested with plain node.
 *
 * Auth tokens are typically injected via environment variables referenced from the config
 * (`${NPM_TOKEN}` / `%NUGET_PAT%`); we expand those from `process.env`.
 */

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_NUGET_INDEX = 'https://api.nuget.org/v3/index.json';

export interface NpmFeed {
  /** Registry base URL (always ends with a single trailing slash). */
  baseUrl: string;
  headers: Record<string, string>;
}

export interface NugetSource {
  key: string;
  /** The `value` from <packageSources>, usually a V3 `.../index.json` service index. */
  indexUrl: string;
  headers: Record<string, string>;
}

/**
 * The endpoints discovered for a NuGet source. A feed may expose any combination of these:
 *  - `flatContainer` (PackageBaseAddress/3.0.0) — the fast path for version lists and nuspecs.
 *  - `registrationsBase` (RegistrationsBaseUrl) — fallback for feeds without a flat container,
 *    notably GitHub Packages.
 *  - `v2Base` — a legacy V2 (OData) feed, used when the source isn't a V3 `index.json`.
 */
export interface NugetServiceEndpoints {
  /** PackageBaseAddress base URL (ends with a slash); build `<id>/index.json` etc. under it. */
  flatContainer?: string;
  /** RegistrationsBaseUrl base URL (ends with a slash); build `<id>/index.json` under it. */
  registrationsBase?: string;
  /** Legacy V2 (OData) service base URL (ends with a slash). */
  v2Base?: string;
  headers: Record<string, string>;
}

/* ------------------------------- URL helpers ------------------------------ */

/** Join a base and path with exactly one slash between them. */
export function joinUrl(base: string, sub: string): string {
  return base.replace(/\/+$/, '') + '/' + sub.replace(/^\/+/, '');
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

/** npm's auth "identity" for a registry URL: `//host[:port]/path/` (no protocol). */
function registryIdentity(url: string): string {
  try {
    const u = new URL(url);
    return `//${u.host}${withTrailingSlash(u.pathname)}`;
  } catch {
    return url;
  }
}

/* ---------------------------------- env ----------------------------------- */

/** Expand `${VAR}` (npm-style) references from the environment. */
function expandNpmEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}

/** Expand `%VAR%` (NuGet/Windows-style) references from the environment. */
function expandNugetEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? _);
}

/* =============================== npm (.npmrc) ============================== */

interface NpmConfig {
  registry: string;
  /** '@scope' -> registry URL. */
  scopedRegistry: Map<string, string>;
  /** registry identity (`//host/path/`) -> auth material. */
  auth: Map<string, { token?: string; basic?: string; username?: string; password?: string }>;
}

const npmConfigCache = new Map<string, NpmConfig>();

/** `.npmrc` files from lowest to highest precedence: user home, then root→…→projectDir. */
function npmrcFiles(projectDir: string): string[] {
  const files: string[] = [];
  const home = path.join(os.homedir(), '.npmrc');
  if (fs.existsSync(home)) {
    files.push(home);
  }
  const chain: string[] = [];
  let dir = projectDir;
  for (;;) {
    const candidate = path.join(dir, '.npmrc');
    if (fs.existsSync(candidate)) {
      chain.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  chain.reverse(); // root first (lower precedence), projectDir last (higher precedence)
  return [...files, ...chain];
}

const NPM_AUTH_FIELD = /^(\/\/.+):(_authToken|_auth|username|_password)$/;

function loadNpmConfig(projectDir: string): NpmConfig {
  const cached = npmConfigCache.get(projectDir);
  if (cached) {
    return cached;
  }
  const cfg: NpmConfig = {
    registry: DEFAULT_NPM_REGISTRY,
    scopedRegistry: new Map(),
    auth: new Map(),
  };
  for (const file of npmrcFiles(projectDir)) {
    try {
      parseNpmrc(fs.readFileSync(file, 'utf8'), cfg);
    } catch {
      // Unreadable .npmrc — ignore and fall back to whatever we have.
    }
  }
  npmConfigCache.set(projectDir, cfg);
  return cfg;
}

/** Parse one `.npmrc` file's contents into `cfg` (later files override earlier). Exported for tests. */
export function parseNpmrc(text: string, cfg: NpmConfig): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = expandNpmEnv(stripQuotes(line.slice(eq + 1).trim()));

    if (key === 'registry') {
      cfg.registry = withTrailingSlash(value);
      continue;
    }
    const scoped = /^(@[^:]+):registry$/.exec(key);
    if (scoped) {
      cfg.scopedRegistry.set(scoped[1], withTrailingSlash(value));
      continue;
    }
    const auth = NPM_AUTH_FIELD.exec(key);
    if (auth) {
      const identity = withTrailingSlash(auth[1]);
      const entry = cfg.auth.get(identity) ?? {};
      if (auth[2] === '_authToken') {
        entry.token = value;
      } else if (auth[2] === '_auth') {
        entry.basic = value;
      } else if (auth[2] === 'username') {
        entry.username = value;
      } else if (auth[2] === '_password') {
        entry.password = value;
      }
      cfg.auth.set(identity, entry);
    }
  }
}

function npmAuthHeaders(registry: string, cfg: NpmConfig): Record<string, string> {
  const target = registryIdentity(registry);
  let bestKey = '';
  for (const key of cfg.auth.keys()) {
    if (target.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  if (!bestKey) {
    return {};
  }
  const entry = cfg.auth.get(bestKey)!;
  if (entry.token) {
    return { authorization: `Bearer ${entry.token}` };
  }
  if (entry.basic) {
    return { authorization: `Basic ${entry.basic}` };
  }
  if (entry.username && entry.password) {
    // npm stores _password base64-encoded.
    const pass = Buffer.from(entry.password, 'base64').toString('utf8');
    const basic = Buffer.from(`${entry.username}:${pass}`).toString('base64');
    return { authorization: `Basic ${basic}` };
  }
  return {};
}

/** The registry + auth headers to use for `name` in a project rooted at `projectDir`. */
export function resolveNpmFeed(name: string, projectDir: string): NpmFeed {
  const cfg = loadNpmConfig(projectDir);
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
  const baseUrl = (scope && cfg.scopedRegistry.get(scope)) || cfg.registry;
  return { baseUrl: withTrailingSlash(baseUrl), headers: npmAuthHeaders(baseUrl, cfg) };
}

/* ============================ NuGet (NuGet.config) ========================= */

interface NugetConfig {
  /** source key -> URL. Insertion order preserved. */
  sources: Map<string, string>;
  disabled: Set<string>; // lowercased keys
  /** source key -> ready-to-use `Authorization` header value (already env-expanded). */
  credentials: Map<string, string>;
  /** source key -> DPAPI-encrypted `<Password>` creds that still need OS-level decryption. */
  encrypted: Map<string, { username?: string; password: string }>;
  /** source key -> glob patterns (from packageSourceMapping); empty map = no mapping. */
  mapping: Map<string, string[]>;
}

const nugetConfigCache = new Map<string, NugetConfig>();
const serviceIndexCache = new Map<string, Promise<NugetServiceEndpoints | undefined>>();
const dpapiCache = new Map<string, string | undefined>();
let vssCredsCache: Map<string, { username?: string; password: string }> | undefined;
let warnedEncryptedPassword = false;

/** `NuGet.config` files from lowest to highest precedence: user-level, then root→…→projectDir. */
function nugetConfigFiles(projectDir: string): string[] {
  const files: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) {
    const userLevel = firstExisting([
      path.join(appData, 'NuGet', 'NuGet.Config'),
      path.join(appData, 'NuGet', 'nuget.config'),
    ]);
    if (userLevel) {
      files.push(userLevel);
    }
  }
  const chain: string[] = [];
  let dir = projectDir;
  for (;;) {
    const found = firstExisting([
      path.join(dir, 'NuGet.config'),
      path.join(dir, 'NuGet.Config'),
      path.join(dir, 'nuget.config'),
    ]);
    if (found) {
      chain.push(found);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  chain.reverse();
  return [...files, ...chain];
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => fs.existsSync(c));
}

function loadNugetConfig(projectDir: string): NugetConfig {
  const cached = nugetConfigCache.get(projectDir);
  if (cached) {
    return cached;
  }
  const cfg: NugetConfig = {
    sources: new Map(),
    disabled: new Set(),
    credentials: new Map(),
    encrypted: new Map(),
    mapping: new Map(),
  };
  let sawAnyConfig = false;
  for (const file of nugetConfigFiles(projectDir)) {
    try {
      parseNugetConfig(fs.readFileSync(file, 'utf8'), cfg);
      sawAnyConfig = true;
    } catch {
      // Ignore unreadable/malformed config.
    }
  }
  // With no config at all, behave like a default install (nuget.org only).
  if (!sawAnyConfig && cfg.sources.size === 0) {
    cfg.sources.set('nuget.org', DEFAULT_NUGET_INDEX);
  }
  nugetConfigCache.set(projectDir, cfg);
  return cfg;
}

/** Parse one NuGet.config into `cfg`, honoring `<clear/>` and later-file precedence. Exported for tests. */
export function parseNugetConfig(xml: string, cfg: NugetConfig): void {
  const sourcesBlock = section(xml, 'packageSources');
  if (sourcesBlock !== undefined) {
    if (/<clear\s*\/?>/i.test(sourcesBlock)) {
      cfg.sources.clear();
    }
    for (const { key, value } of readAddEntries(sourcesBlock)) {
      if (value) {
        cfg.sources.set(key, expandNugetEnv(value));
      }
    }
  }

  const disabledBlock = section(xml, 'disabledPackageSources');
  if (disabledBlock !== undefined) {
    for (const { key, value } of readAddEntries(disabledBlock)) {
      if (/^true$/i.test(value)) {
        cfg.disabled.add(key.toLowerCase());
      } else {
        cfg.disabled.delete(key.toLowerCase());
      }
    }
  }

  const credsBlock = section(xml, 'packageSourceCredentials');
  if (credsBlock !== undefined) {
    parseCredentials(credsBlock, cfg);
  }

  const mappingBlock = section(xml, 'packageSourceMapping');
  if (mappingBlock !== undefined) {
    // A file that declares mapping replaces any inherited mapping (nearest config wins).
    cfg.mapping.clear();
    const srcRegex = /<packageSource\b[^>]*\bkey\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/packageSource>/gi;
    let m: RegExpExecArray | null;
    while ((m = srcRegex.exec(mappingBlock))) {
      const patterns: string[] = [];
      const patRegex = /<package\b[^>]*\bpattern\s*=\s*"([^"]*)"/gi;
      let p: RegExpExecArray | null;
      while ((p = patRegex.exec(m[2]))) {
        patterns.push(p[1]);
      }
      cfg.mapping.set(m[1], patterns);
    }
  }
}

function parseCredentials(block: string, cfg: NugetConfig): void {
  // <packageSourceCredentials><SourceKey><add key="Username" .../>...</SourceKey></...>
  const srcRegex = /<([^\s/>]+)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = srcRegex.exec(block))) {
    const key = decodeSourceKey(m[1]);
    const entries = new Map(readAddEntries(m[2]).map((e) => [e.key.toLowerCase(), e.value]));
    const username = entries.get('username');
    const clear = entries.get('cleartextpassword');
    const encrypted = entries.get('password');
    if (clear) {
      // Feeds like Azure DevOps accept any username with a PAT as the password; others (token
      // feeds) leave the username empty. Send whatever the config provides.
      const basic = Buffer.from(`${username ?? ''}:${expandNugetEnv(clear)}`).toString('base64');
      cfg.credentials.set(key, `Basic ${basic}`);
    } else if (encrypted) {
      // DPAPI-encrypted <Password> — decrypted lazily on Windows in resolveNugetSources.
      cfg.encrypted.set(key, { username, password: encrypted });
    }
  }
}

/* -------------------------- NuGet credential sources ---------------------- */

/**
 * Decrypt a NuGet DPAPI-encrypted `<Password>` and turn it into a Basic auth header. NuGet
 * encrypts with `ProtectedData.Protect(bytes, utf8("NuGet"), CurrentUser)`, so we can only decrypt
 * on the same Windows user via PowerShell. Returns undefined off-Windows or on failure.
 */
function decryptNugetCredential(enc?: { username?: string; password: string }): string | undefined {
  if (!enc) {
    return undefined;
  }
  const password = decryptDpapi(enc.password);
  if (password === undefined) {
    return undefined;
  }
  const basic = Buffer.from(`${enc.username ?? ''}:${password}`).toString('base64');
  return `Basic ${basic}`;
}

function decryptDpapi(encrypted: string): string | undefined {
  if (dpapiCache.has(encrypted)) {
    return dpapiCache.get(encrypted);
  }
  let result: string | undefined;
  if (process.platform !== 'win32') {
    warnEncrypted('encrypted NuGet <Password> values can only be decrypted on Windows');
  } else {
    try {
      const script =
        'Add-Type -AssemblyName System.Security;' +
        '$e=[Convert]::FromBase64String($env:DE_NUGET_ENC);' +
        "$p=[Text.Encoding]::UTF8.GetBytes('NuGet');" +
        "$d=[Security.Cryptography.ProtectedData]::Unprotect($e,$p,'CurrentUser');" +
        '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, DE_NUGET_ENC: encrypted },
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      result = out.length > 0 ? out : undefined;
    } catch {
      warnEncrypted('failed to decrypt an encrypted NuGet <Password> via DPAPI');
    }
  }
  dpapiCache.set(encrypted, result);
  return result;
}

/**
 * Credentials injected by the Azure Artifacts Credential Provider (and compatible CI setups) via
 * the `VSS_NUGET_EXTERNAL_FEED_ENDPOINTS` env var. Keyed by normalized endpoint (service index) URL.
 */
function vssEndpointCredentials(): Map<string, { username?: string; password: string }> {
  if (vssCredsCache) {
    return vssCredsCache;
  }
  const map = new Map<string, { username?: string; password: string }>();
  const raw = process.env.VSS_NUGET_EXTERNAL_FEED_ENDPOINTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        endpointCredentials?: { endpoint?: string; username?: string; password?: string }[];
      };
      for (const c of parsed.endpointCredentials ?? []) {
        if (c.endpoint && c.password) {
          map.set(normalizeEndpoint(c.endpoint), { username: c.username, password: c.password });
        }
      }
    } catch {
      // Malformed env var — ignore.
    }
  }
  vssCredsCache = map;
  return map;
}

function envProviderCredential(indexUrl: string): string | undefined {
  const cred = vssEndpointCredentials().get(normalizeEndpoint(indexUrl));
  if (!cred) {
    return undefined;
  }
  // Azure DevOps accepts any non-empty username paired with the PAT as the password.
  const basic = Buffer.from(`${cred.username || 'AzureDevOps'}:${cred.password}`).toString('base64');
  return `Basic ${basic}`;
}

function normalizeEndpoint(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function warnEncrypted(msg: string): void {
  if (warnedEncryptedPassword) {
    return;
  }
  warnedEncryptedPassword = true;
  console.warn(
    `Dependency Explorer: ${msg}; querying that source anonymously. Use <ClearTextPassword> with ` +
      'an env-var token, or set VSS_NUGET_EXTERNAL_FEED_ENDPOINTS.'
  );
}

/** NuGet.config XML-encodes non-identifier source keys (e.g. "My Feed" -> "My_x0020_Feed"). */
function decodeSourceKey(encoded: string): string {
  return encoded.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function section(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1] : undefined;
}

function readAddEntries(block: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const regex = /<add\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(block))) {
    const key = /\bkey\s*=\s*"([^"]*)"/i.exec(m[1])?.[1];
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? '';
    if (key) {
      out.push({ key, value });
    }
  }
  return out;
}

/* --------------------------- source mapping match ------------------------- */

/** Specificity of a glob pattern for `id`, or -1 if it doesn't match. Higher = more specific. */
function patternScore(pattern: string, id: string): number {
  const lid = id.toLowerCase();
  const lpat = pattern.toLowerCase();
  if (lpat === '*') {
    return 0;
  }
  if (lpat.endsWith('*')) {
    const prefix = lpat.slice(0, -1);
    return lid.startsWith(prefix) ? prefix.length : -1;
  }
  return lid === lpat ? lpat.length + 1 : -1;
}

/** Filter sources to those that own the most-specific mapping pattern for `name`. */
function applyMapping(name: string, cfg: NugetConfig, keys: string[]): string[] {
  if (cfg.mapping.size === 0) {
    return keys;
  }
  let best = -1;
  const winners: string[] = [];
  for (const key of keys) {
    const patterns = cfg.mapping.get(key) ?? [];
    const score = Math.max(-1, ...patterns.map((p) => patternScore(p, name)));
    if (score > best) {
      best = score;
      winners.length = 0;
      winners.push(key);
    } else if (score === best && score >= 0) {
      winners.push(key);
    }
  }
  return best >= 0 ? winners : [];
}

/** Enabled, mapping-filtered sources (with auth headers) to query for `name`. */
export function resolveNugetSources(name: string, projectDir: string): NugetSource[] {
  const cfg = loadNugetConfig(projectDir);
  const enabled = [...cfg.sources.keys()].filter((k) => !cfg.disabled.has(k.toLowerCase()));
  const selected = applyMapping(name, cfg, enabled);
  return selected.map((key) => {
    const indexUrl = cfg.sources.get(key)!;
    // Auth precedence: explicit ClearTextPassword, then a decrypted <Password>, then the
    // credential-provider env var. Any of these may be absent for a public/internal feed.
    const cred =
      cfg.credentials.get(key) ??
      decryptNugetCredential(cfg.encrypted.get(key)) ??
      envProviderCredential(indexUrl);
    const headers: Record<string, string> = cred ? { authorization: cred } : {};
    return { key, indexUrl, headers };
  });
}

/** V3 registration resource types, most SemVer2-capable first. */
const REG_TYPE_PREFERENCE = [
  'RegistrationsBaseUrl/3.6.0',
  'RegistrationsBaseUrl/Versioned',
  'RegistrationsBaseUrl/3.4.0',
  'RegistrationsBaseUrl/3.0.0-rc',
  'RegistrationsBaseUrl/3.0.0-beta',
  'RegistrationsBaseUrl',
];

/**
 * Discover (and cache) the endpoints a source exposes. For a V3 service index we surface both the
 * flat container and a registrations base (some feeds, e.g. GitHub Packages, offer only the
 * latter). A non-`.json` source is treated as a legacy V2 (OData) feed. Returns undefined only
 * when a V3 index is configured but unreachable.
 */
export function getNugetServiceEndpoints(
  source: NugetSource,
  signal?: AbortSignal
): Promise<NugetServiceEndpoints | undefined> {
  const cached = serviceIndexCache.get(source.indexUrl);
  if (cached) {
    return cached;
  }
  const promise = (async (): Promise<NugetServiceEndpoints | undefined> => {
    if (!/\.json(\?|$)/i.test(source.indexUrl)) {
      // Not a V3 service index — treat it as a legacy V2 OData feed and query it directly.
      return { v2Base: withTrailingSlash(source.indexUrl), headers: source.headers };
    }
    try {
      const res = await fetch(source.indexUrl, { headers: source.headers, signal });
      if (!res.ok) {
        // 4xx/5xx is a property of the feed — cache it so we don't re-hit a broken source.
        return undefined;
      }
      const data = (await res.json()) as { resources?: { '@id': string; '@type': string }[] };
      const resources = data.resources ?? [];
      const flat = resources.find((r) => r['@type']?.startsWith('PackageBaseAddress/3.0.0'));
      let registrationsBase: string | undefined;
      for (const type of REG_TYPE_PREFERENCE) {
        const hit = resources.find((r) => r['@type'] === type);
        if (hit?.['@id']) {
          registrationsBase = withTrailingSlash(hit['@id']);
          break;
        }
      }
      return {
        flatContainer: flat?.['@id'] ? withTrailingSlash(flat['@id']) : undefined,
        registrationsBase,
        headers: source.headers,
      };
    } catch {
      // A timeout/abort or network blip is transient — drop it from the cache so a later package
      // (with a fresh budget) can retry this source instead of inheriting the failure.
      serviceIndexCache.delete(source.indexUrl);
      return undefined;
    }
  })();
  serviceIndexCache.set(source.indexUrl, promise);
  return promise;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']/, '').replace(/["']$/, '');
}

/** Test hook: clear all session caches so a fresh config can be loaded. */
export function _resetFeedCaches(): void {
  npmConfigCache.clear();
  nugetConfigCache.clear();
  serviceIndexCache.clear();
  dpapiCache.clear();
  vssCredsCache = undefined;
  warnedEncryptedPassword = false;
}
