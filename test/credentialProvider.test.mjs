// Tests for Azure DevOps credential-provider support: the extension shelling out to the Microsoft
// Artifacts Credential Provider to authenticate private-feed lookups on a dev machine where the
// token lives in the provider's cache (not in NuGet.config). Unit tests cover parsing/discovery/
// invocation; the end-to-end test drives a stub provider (matching the real one's stdout contract)
// through the real fetchVersions against a mock Azure feed that requires auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SVC = new URL('../out/services/', import.meta.url);
const cp = await import(new URL('credentialProvider.js', SVC));
const { fetchVersions } = await import(new URL('registryService.js', SVC));
const { _resetFeedCaches } = await import(new URL('feedConfig.js', SVC));

// --------------------------------- unit tests ------------------------------
test('isAzureDevOpsFeed recognizes Azure DevOps hosts only', () => {
  assert.equal(cp.isAzureDevOpsFeed('https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json'), true);
  assert.equal(cp.isAzureDevOpsFeed('https://myorg.pkgs.visualstudio.com/_packaging/feed/nuget/v3/index.json'), true);
  assert.equal(cp.isAzureDevOpsFeed('https://api.nuget.org/v3/index.json'), false);
  assert.equal(cp.isAzureDevOpsFeed('not a url'), false);
});

test('parseProviderJson extracts credentials from noisy stdout', () => {
  const out = '[info] acquiring token...\n{"Username":"VssSessionToken","Password":"abc.def.ghi"}\n[info] done\n';
  assert.deepEqual(cp.parseProviderJson(out), { Username: 'VssSessionToken', Password: 'abc.def.ghi' });
});
test('parseProviderJson returns undefined when there is no credential', () => {
  assert.equal(cp.parseProviderJson('error: no cached token\n'), undefined);
  assert.equal(cp.parseProviderJson('{"Username":"x","Password":""}'), undefined);
});

test('buildInvocation runs a .dll under dotnet and an executable directly, requesting JSON output', () => {
  const flags = ['-Uri', 'https://feed', '-NonInteractive', '-OutputFormat', 'Json', '-Verbosity', 'Minimal'];
  const dll = cp.buildInvocation('/p/CredentialProvider.Microsoft.dll', 'https://feed');
  assert.equal(dll.cmd, process.env.DOTNET_HOST_PATH || 'dotnet');
  assert.deepEqual(dll.args, ['/p/CredentialProvider.Microsoft.dll', ...flags]);
  const exe = cp.buildInvocation('/p/CredentialProvider.Microsoft.exe', 'https://feed');
  assert.equal(exe.cmd, '/p/CredentialProvider.Microsoft.exe');
  assert.deepEqual(exe.args, flags);
});

test('resolvePlugin honors NUGET_PLUGIN_PATHS as a file or a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-plugin-'));
  const dll = path.join(dir, 'CredentialProvider.Microsoft.dll');
  fs.writeFileSync(dll, '');
  const saved = process.env.NUGET_PLUGIN_PATHS;
  try {
    process.env.NUGET_PLUGIN_PATHS = dll; // explicit file
    assert.equal(cp.resolvePlugin(), dll);
    process.env.NUGET_PLUGIN_PATHS = dir; // directory containing the binary
    assert.equal(cp.resolvePlugin(), dll);
  } finally {
    if (saved === undefined) delete process.env.NUGET_PLUGIN_PATHS; else process.env.NUGET_PLUGIN_PATHS = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------- end-to-end with a stub provider -----------------
const PAT = 'session-token-xyz';
let PORT, tmp, stubPath, countFile;
const hits = {};

const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] ?? 0) + 1;
  const m = /^Basic (.+)$/.exec(req.headers['authorization'] || '');
  const [user, pass] = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':') : [];
  if (!user || pass !== PAT) { res.statusCode = 401; return res.end('unauthorized'); }
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (req.url === '/azure/index.json') {
    return json({ resources: [{ '@id': `http://127.0.0.1:${PORT}/azure/flat/`, '@type': 'PackageBaseAddress/3.0.0' }] });
  }
  if (/^\/azure\/flat\/.+\/index\.json$/.test(req.url)) return json({ versions: ['5.0.0'] });
  res.statusCode = 404; res.end('nf');
});

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-cp-'));
  countFile = path.join(tmp, 'invocations');
  fs.writeFileSync(countFile, '');
  // Stub provider: records each invocation, then mimics the real provider's stdout (or fails when
  // STUB_FAIL is set, standing in for "no cached token / not signed in").
  stubPath = path.join(tmp, 'stub-provider.mjs');
  fs.writeFileSync(
    stubPath,
    `#!/usr/bin/env node\n` +
      `import fs from 'node:fs';\n` +
      `fs.appendFileSync(process.env.STUB_COUNT_FILE, 'x');\n` +
      `if (process.env.STUB_FAIL) { console.error('no cached token'); process.exit(2); }\n` +
      `console.log('[info] token acquired');\n` +
      `console.log(JSON.stringify({ Username: 'VssSessionToken', Password: process.env.STUB_PAT }));\n`
  );
  fs.chmodSync(stubPath, 0o755);
});
after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function azureProjectDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'NuGet.config'),
    `<?xml version="1.0"?><configuration><packageSources><clear/>` +
      `<add key="azure" value="http://127.0.0.1:${PORT}/azure/index.json" /></packageSources></configuration>`
  );
  return dir;
}

test('authenticates an Azure feed via the credential provider (no creds in NuGet.config)', async () => {
  const saved = { paths: process.env.NUGET_PLUGIN_PATHS, pat: process.env.STUB_PAT, cf: process.env.STUB_COUNT_FILE };
  process.env.NUGET_PLUGIN_PATHS = stubPath;
  process.env.STUB_PAT = PAT;
  process.env.STUB_COUNT_FILE = countFile;
  fs.writeFileSync(countFile, '');
  delete process.env.STUB_FAIL;
  try {
    _resetFeedCaches();
    const dir = azureProjectDir('ok');
    // A whole parallel batch — the provider must be invoked once, then its token reused.
    const batch = await Promise.all(['A', 'B', 'C', 'D'].map((n) => fetchVersions('NuGet', n, dir)));
    assert.ok(batch.every((r) => r.latest === '5.0.0'), 'every lookup authenticated and resolved');
    assert.equal(fs.readFileSync(countFile, 'utf8').length, 1, 'credential provider invoked exactly once for the batch');
  } finally {
    _resetFeedCaches();
    for (const [k, v] of [['NUGET_PLUGIN_PATHS', saved.paths], ['STUB_PAT', saved.pat], ['STUB_COUNT_FILE', saved.cf]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a not-signed-in provider surfaces a clear auth error', async () => {
  const saved = { paths: process.env.NUGET_PLUGIN_PATHS, cf: process.env.STUB_COUNT_FILE };
  process.env.NUGET_PLUGIN_PATHS = stubPath;
  process.env.STUB_COUNT_FILE = countFile;
  process.env.STUB_FAIL = '1'; // provider can't get a token non-interactively
  try {
    _resetFeedCaches();
    const dir = azureProjectDir('fail');
    const err = await fetchVersions('NuGet', 'Pkg', dir).then(() => undefined, (e) => e);
    assert.ok(err, 'lookup rejects');
    assert.match(err.message, /authentication failed \(HTTP 401\)/);
  } finally {
    delete process.env.STUB_FAIL;
    _resetFeedCaches();
    if (saved.paths === undefined) delete process.env.NUGET_PLUGIN_PATHS; else process.env.NUGET_PLUGIN_PATHS = saved.paths;
    if (saved.cf === undefined) delete process.env.STUB_COUNT_FILE; else process.env.STUB_COUNT_FILE = saved.cf;
  }
});
