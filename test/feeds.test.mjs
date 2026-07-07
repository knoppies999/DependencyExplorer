// Feed-resolution tests: run against the compiled out/services/*.js (feedConfig + registryService
// are deliberately free of any vscode import, so they run under plain node). Covers:
//   - the fast-fail / negative-cache behavior that keeps bulk commands from stalling on a dead feed
//   - NuGet feed authentication (Azure DevOps-style Basic auth: non-empty username + PAT)
//
// Run with:  npm test   (compiles first, then `node --test test/`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = new URL('../out/services/', import.meta.url);
const { fetchVersions } = await import(new URL('registryService.js', OUT));
const { _resetFeedCaches } = await import(new URL('feedConfig.js', OUT));

// ---------------------------------------------------------------------------
// Mock server: unauthenticated /healthy + /dead feeds, plus an /azure feed that
// enforces Azure DevOps-style Basic auth (any NON-EMPTY username + the PAT).
// ---------------------------------------------------------------------------
const PAT = 'secret-pat-123';
const hits = {};
let PORT;
const hanging = [];

function azureAuthOK(req) {
  const m = /^Basic (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const [user, pass] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return !!user && pass === PAT; // empty username is rejected, like Azure DevOps
}

const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] ?? 0) + 1;
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };

  if (req.url === '/healthy/index.json') {
    return json({ resources: [{ '@id': `http://127.0.0.1:${PORT}/healthy/flat/`, '@type': 'PackageBaseAddress/3.0.0' }] });
  }
  if (/^\/healthy\/flat\/.+\/index\.json$/.test(req.url)) {
    return json({ versions: ['1.0.0', '1.1.0', '2.0.0'] });
  }
  if (req.url === '/dead/index.json') { hanging.push(res); return; } // never responds

  if (req.url.startsWith('/azure/')) {
    if (!azureAuthOK(req)) { res.statusCode = 401; return res.end('unauthorized'); }
    if (req.url === '/azure/index.json') {
      return json({ resources: [{ '@id': `http://127.0.0.1:${PORT}/azure/flat/`, '@type': 'PackageBaseAddress/3.0.0' }] });
    }
    if (/^\/azure\/flat\/.+\/index\.json$/.test(req.url)) return json({ versions: ['3.0.0'] });
  }
  res.statusCode = 404; res.end('not found');
});

let tmp;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-feeds-'));
});
after(() => {
  hanging.forEach((r) => r.destroy());
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Make a temp project dir with a NuGet.config listing `sources` and an optional credentials block. */
function mkProj(name, sources, credXml = '') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const adds = sources.map((s) => `<add key="${s.key}" value="${s.url}" />`).join('');
  fs.writeFileSync(
    path.join(dir, 'NuGet.config'),
    `<?xml version="1.0"?><configuration><packageSources><clear/>${adds}</packageSources>${credXml}</configuration>`
  );
  return dir;
}
const src = (key, p) => ({ key, url: `http://127.0.0.1:${PORT}${p}` });
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

// ---------------------------------------------------------------------------
// Fast-fail + negative cache (keeps "fix/update all" from stalling on a dead feed)
// ---------------------------------------------------------------------------
test('healthy feed resolves versions newest-first', async () => {
  _resetFeedCaches();
  const r = await fetchVersions('NuGet', 'Foo.Bar', mkProj('healthy', [src('mock', '/healthy/index.json')]));
  assert.deepEqual(r.versions, ['2.0.0', '1.1.0', '1.0.0']);
  assert.equal(r.latest, '2.0.0');
});

test('a dead feed is probed once for a whole parallel batch and fails fast (~8s, not 30s)', async () => {
  _resetFeedCaches();
  hits['/dead/index.json'] = 0;
  const dir = mkProj('dead', [src('dead', '/dead/index.json')]);
  const started = Date.now();
  const batch = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => settle(fetchVersions('NuGet', n, dir))));
  const elapsed = Date.now() - started;

  assert.ok(batch.every((x) => x.ok === false), 'all lookups reject');
  assert.equal(hits['/dead/index.json'], 1, 'dead index probed exactly once for 5 packages');
  assert.ok(elapsed < 15000, `bounded by one ~8s probe, not 5×8s (was ${elapsed}ms)`);

  // Within the failure TTL a follow-up is instant and adds no new probe (negative cache).
  const t2 = Date.now();
  const follow = await settle(fetchVersions('NuGet', 'F', dir));
  assert.equal(follow.ok, false);
  assert.ok(Date.now() - t2 < 500, 'follow-up returns instantly from the negative cache');
  assert.equal(hits['/dead/index.json'], 1, 'still only one probe');
});

test('a dead source does not block a healthy source in the same config', async () => {
  _resetFeedCaches();
  const dir = mkProj('mixed', [src('dead', '/dead/index.json'), src('mock', '/healthy/index.json')]);
  const started = Date.now();
  const results = await Promise.all(['A', 'B', 'C'].map((n) => fetchVersions('NuGet', n, dir)));
  assert.ok(results.every((r) => r.latest === '2.0.0'), 'each still resolves via the healthy source');
  assert.ok(Date.now() - started < 15000, 'bounded by the single dead probe');
});

// ---------------------------------------------------------------------------
// NuGet feed authentication (Azure DevOps-style Basic auth)
// ---------------------------------------------------------------------------
test('authenticates via NuGet.config ClearTextPassword — with a username', async () => {
  _resetFeedCaches();
  const cred = `<packageSourceCredentials><azure>` +
    `<add key="Username" value="anything" /><add key="ClearTextPassword" value="${PAT}" />` +
    `</azure></packageSourceCredentials>`;
  const r = await fetchVersions('NuGet', 'Pkg', mkProj('ct-user', [src('azure', '/azure/index.json')], cred));
  assert.deepEqual(r.versions, ['3.0.0']);
});

test('authenticates via ClearTextPassword when the username is OMITTED (empty-user fallback)', async () => {
  _resetFeedCaches();
  const cred = `<packageSourceCredentials><azure>` +
    `<add key="ClearTextPassword" value="${PAT}" />` +
    `</azure></packageSourceCredentials>`;
  const r = await fetchVersions('NuGet', 'Pkg', mkProj('ct-nouser', [src('azure', '/azure/index.json')], cred));
  assert.deepEqual(r.versions, ['3.0.0'], 'a missing <Username> must not produce an empty Basic user');
});

test('authenticates via VSS_NUGET_EXTERNAL_FEED_ENDPOINTS (credential provider / CI)', async () => {
  const dir = mkProj('vss', [src('azure', '/azure/index.json')]);
  const endpoint = `http://127.0.0.1:${PORT}/azure/index.json`;
  process.env.VSS_NUGET_EXTERNAL_FEED_ENDPOINTS = JSON.stringify({
    endpointCredentials: [{ endpoint, password: PAT }], // no username → relies on fallback
  });
  try {
    _resetFeedCaches();
    const r = await fetchVersions('NuGet', 'Pkg', dir);
    assert.deepEqual(r.versions, ['3.0.0']);
  } finally {
    delete process.env.VSS_NUGET_EXTERNAL_FEED_ENDPOINTS;
    _resetFeedCaches();
  }
});

test('authenticates via ARTIFACTS_CREDENTIALPROVIDER_EXTERNAL_FEED_ENDPOINTS (modern env var)', async () => {
  const dir = mkProj('artifacts', [src('azure', '/azure/index.json')]);
  const endpoint = `http://127.0.0.1:${PORT}/azure/index.json`;
  process.env.ARTIFACTS_CREDENTIALPROVIDER_EXTERNAL_FEED_ENDPOINTS = JSON.stringify({
    endpointCredentials: [{ endpoint, username: 'build', password: PAT }],
  });
  try {
    _resetFeedCaches();
    const r = await fetchVersions('NuGet', 'Pkg', dir);
    assert.deepEqual(r.versions, ['3.0.0']);
  } finally {
    delete process.env.ARTIFACTS_CREDENTIALPROVIDER_EXTERNAL_FEED_ENDPOINTS;
    _resetFeedCaches();
  }
});

test('an auth failure surfaces as an auth error, not "unreachable"', async () => {
  _resetFeedCaches();
  const dir = mkProj('noauth', [src('azure', '/azure/index.json')]); // no credentials at all
  const r = await settle(fetchVersions('NuGet', 'Pkg', dir));
  assert.equal(r.ok, false);
  assert.match(r.e.message, /authentication failed \(HTTP 401\)/, `got: ${r.ok ? 'resolved' : r.e.message}`);
});
