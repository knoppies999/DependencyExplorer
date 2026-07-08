// previewService.js pure helpers: diffDependencies (the added/removed/changed/unchanged diff shown
// in the preview panel) and parseNuspecDeps (NuGet .nuspec dependency-group parsing). The network
// fetchers aren't exercised here. Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { diffDependencies, parseNuspecDeps } = await import(new URL('previewService.js', OUT));

// ---------------------------------------------------------------------------
// diffDependencies
// ---------------------------------------------------------------------------
test('diffDependencies classifies added / removed / changed / unchanged', () => {
  const current = [
    { name: 'a', range: '^1.0.0' },
    { name: 'b', range: '^1.0.0' },
    { name: 'c', range: '^1.0.0' },
  ];
  const target = [
    { name: 'a', range: '^2.0.0' }, // changed
    { name: 'b', range: '^1.0.0' }, // unchanged
    { name: 'd', range: '^1.0.0' }, // added
    // c removed
  ];
  const changes = diffDependencies(current, target);
  const byName = Object.fromEntries(changes.map((c) => [c.name, c.status]));
  assert.equal(byName.a, 'changed');
  assert.equal(byName.b, 'unchanged');
  assert.equal(byName.c, 'removed');
  assert.equal(byName.d, 'added');
});

test('diffDependencies orders changed, then added, then removed, then unchanged', () => {
  const current = [
    { name: 'a', range: '^1.0.0' },
    { name: 'keep', range: '^1.0.0' },
    { name: 'gone', range: '^1.0.0' },
  ];
  const target = [
    { name: 'a', range: '^2.0.0' },
    { name: 'keep', range: '^1.0.0' },
    { name: 'new', range: '^1.0.0' },
  ];
  const order = diffDependencies(current, target).map((c) => c.status);
  assert.deepEqual(order, ['changed', 'added', 'removed', 'unchanged']);
});

test('diffDependencies matches names case-insensitively and carries the optional flag', () => {
  const current = [{ name: 'Foo', range: '^1.0.0' }];
  const target = [{ name: 'foo', range: '^1.0.0' }, { name: 'opt', range: '^1.0.0', optional: true }];
  const changes = diffDependencies(current, target);
  assert.equal(changes.find((c) => c.name.toLowerCase() === 'foo').status, 'unchanged');
  assert.equal(changes.find((c) => c.name === 'opt').optional, true);
});

// ---------------------------------------------------------------------------
// parseNuspecDeps
// ---------------------------------------------------------------------------
const grouped = `<?xml version="1.0"?>
<package><metadata><dependencies>
  <group targetFramework="net8.0">
    <dependency id="A" version="1.0.0" />
  </group>
  <group targetFramework="net9.0">
    <dependency id="B" version="2.0.0" />
    <dependency id="C" version="3.0.0" />
  </group>
</dependencies></metadata></package>`;

test('parseNuspecDeps picks the matching target-framework group', () => {
  const { deps, framework } = parseNuspecDeps(grouped, 'net9.0');
  assert.deepEqual(deps.map((d) => d.name), ['B', 'C']);
  assert.equal(framework, 'net9.0');
});

test('parseNuspecDeps normalises the framework moniker when matching', () => {
  // ".NETCoreApp,Version=v9.0"-style vs "net9.0" both normalise to net90.
  const { deps } = parseNuspecDeps(grouped, 'NET9.0');
  assert.deepEqual(deps.map((d) => d.name), ['B', 'C']);
});

test('parseNuspecDeps falls back to the first group when none matches', () => {
  const { deps, framework } = parseNuspecDeps(grouped, 'net10.0');
  assert.deepEqual(deps.map((d) => d.name), ['A']);
  assert.equal(framework, 'net8.0');
});

test('parseNuspecDeps handles a legacy flat dependency list (no groups)', () => {
  const flat = `<package><metadata><dependencies>
    <dependency id="X" version="1.0.0" />
    <dependency id="Y" version="2.0.0" />
  </dependencies></metadata></package>`;
  const { deps, framework } = parseNuspecDeps(flat);
  assert.deepEqual(deps.map((d) => d.name), ['X', 'Y']);
  assert.equal(framework, undefined);
});

test('parseNuspecDeps skips a dependency with no id, and returns [] when there is no block', () => {
  const noId = `<dependencies><dependency version="1.0.0" /><dependency id="Z" version="2.0.0" /></dependencies>`;
  assert.deepEqual(parseNuspecDeps(noId).deps.map((d) => d.name), ['Z']);
  assert.deepEqual(parseNuspecDeps('<package></package>'), { deps: [] });
});
