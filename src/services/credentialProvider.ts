import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Obtains NuGet credentials for Azure DevOps Artifacts feeds from the Microsoft Artifacts Credential
 * Provider (the plugin `dotnet`/Visual Studio use), so private-feed lookups work on a developer
 * machine where the token lives in the provider's cache rather than in NuGet.config.
 *
 * We invoke the provider in its standalone, non-interactive mode — it prints the credential as
 * `{"Username":"...","Password":"..."}` on stdout — and turn that into a Basic auth header. Runs at
 * most once per feed per session (cached), and never prompts: if there's no cached token it fails
 * fast and the caller surfaces an auth error telling the user to sign in (e.g. via `dotnet restore`).
 *
 * Deliberately free of any `vscode` import so it can be unit-tested with plain node.
 */

/** How long to wait for the provider before giving up (a cached token resolves near-instantly). */
const CRED_PROVIDER_TIMEOUT_MS = 15_000;

const authCache = new Map<string, Promise<string | undefined>>();

/** True for Azure DevOps Services feed hosts, which the Microsoft credential provider serves. */
export function isAzureDevOpsFeed(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === 'pkgs.dev.azure.com' || host.endsWith('.pkgs.visualstudio.com');
  } catch {
    return false;
  }
}

/** Basic auth header from the credential provider for `feedUrl`, or undefined if none is available. */
export function getCredentialProviderAuth(feedUrl: string): Promise<string | undefined> {
  const cached = authCache.get(feedUrl);
  if (cached) {
    return cached;
  }
  const promise = acquire(feedUrl);
  authCache.set(feedUrl, promise);
  return promise;
}

/** Test hook: forget any credentials fetched from the provider this session. */
export function _resetCredentialProviderCache(): void {
  authCache.clear();
}

/** Candidate provider executables, honoring `NUGET_PLUGIN_PATHS` then the default install dirs. */
function pluginCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.NUGET_PLUGIN_PATHS;
  if (fromEnv) {
    for (const part of fromEnv.split(path.delimiter)) {
      if (part.trim()) {
        candidates.push(part.trim());
      }
    }
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, '.nuget', 'plugins', 'netcore', 'CredentialProvider.Microsoft', 'CredentialProvider.Microsoft.dll')
  );
  if (process.platform === 'win32') {
    candidates.push(
      path.join(home, '.nuget', 'plugins', 'netfx', 'CredentialProvider.Microsoft', 'CredentialProvider.Microsoft.exe')
    );
  }
  return candidates;
}

/** Resolve a concrete provider binary: a candidate may be the executable itself or its directory. */
export function resolvePlugin(): string | undefined {
  for (const candidate of pluginCandidates()) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const inDir = ['CredentialProvider.Microsoft.dll', 'CredentialProvider.Microsoft.exe']
      .map((f) => path.join(candidate, f))
      .find((f) => fs.existsSync(f));
    if (inDir) {
      return inDir;
    }
  }
  return undefined;
}

/** Build the command + args to run `plugin` against `feedUrl` (a .dll runs under `dotnet`). */
export function buildInvocation(plugin: string, feedUrl: string): { cmd: string; args: string[] } {
  // `-OutputFormat Json` is required: the provider defaults to human-readable text, and only in
  // JSON mode does it write a clean `{"Username","Password"}` credential to stdout (logs go to
  // stderr). `-NonInteractive` stops it from ever prompting for a device-code sign-in.
  const flags = ['-Uri', feedUrl, '-NonInteractive', '-OutputFormat', 'Json', '-Verbosity', 'Minimal'];
  if (plugin.toLowerCase().endsWith('.dll')) {
    return { cmd: process.env.DOTNET_HOST_PATH || 'dotnet', args: [plugin, ...flags] };
  }
  return { cmd: plugin, args: flags };
}

/**
 * Extract a `{ Username, Password }` credential from the provider's stdout. Output may be prefixed
 * with log lines, so we scan for the (flat) JSON object that carries a non-empty Password.
 */
export function parseProviderJson(stdout: string): { Username: string; Password: string } | undefined {
  const objects = stdout.match(/\{[^{}]*"Password"[^{}]*\}/gi) ?? [];
  for (const raw of objects.reverse()) {
    try {
      const obj = JSON.parse(raw) as { Username?: unknown; Password?: unknown };
      if (typeof obj.Password === 'string' && obj.Password) {
        return { Username: typeof obj.Username === 'string' ? obj.Username : '', Password: obj.Password };
      }
    } catch {
      // Not the JSON line — keep scanning.
    }
  }
  return undefined;
}

async function acquire(feedUrl: string): Promise<string | undefined> {
  const plugin = resolvePlugin();
  if (!plugin) {
    return undefined;
  }
  const { cmd, args } = buildInvocation(plugin, feedUrl);
  const stdout = await run(cmd, args);
  if (stdout === undefined) {
    return undefined;
  }
  const creds = parseProviderJson(stdout);
  if (!creds) {
    return undefined;
  }
  // Azure DevOps rejects an empty Basic username; the provider usually returns one, but guard anyway.
  const basic = Buffer.from(`${creds.Username || 'VssSessionToken'}:${creds.Password}`).toString('base64');
  return `Basic ${basic}`;
}

/** Spawn `cmd args`, resolving its stdout on exit 0, or undefined on any failure/timeout. */
function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, CRED_PROVIDER_TIMEOUT_MS);
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      // The provider's success/failure exit codes aren't documented, so let the stdout parse decide:
      // a valid credential JSON means success, anything else (empty stdout, an error) yields none.
      resolve(stdout);
    });
  });
}
