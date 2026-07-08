// npmGraph.js — buildNpmGraph turns a package-lock.json v2/v3 `packages` map into the resolved
// graph. The critical behaviour is node_modules walk-up resolution (a dependency resolves to the
// nearest node_modules copy, not a naive by-name lookup). Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/providers/', import.meta.url);
const { buildNpmGraph } = await import(new URL('npmGraph.js', OUT));

// A lockfile where `a` has its own nested copy of `b`@2, while the top-level `b` is @1. `d` (dev)
// also depends on `b` but has no nested copy, so it must walk up to the top-level `b`@1.
const packages = {
  '': {},
  'node_modules/a': { version: '1.0.0', dependencies: { b: '^2.0.0', zzz: '^1.0.0' } },
  'node_modules/b': { version: '1.0.0' },
  'node_modules/a/node_modules/b': { version: '2.0.0' },
  'node_modules/d': { version: '3.0.0', dev: true, dependencies: { b: '^1.0.0' } },
  'node_modules/linked': { version: '9.9.9', link: true },
  'node_modules/noversion': {},
};

const graph = buildNpmGraph(packages, ['a'], ['d']);

test('resolves direct dependencies to their graph keys', () => {
  assert.deepEqual(graph.directProd, [{ name: 'a', key: 'node_modules/a' }]);
  assert.deepEqual(graph.directDev, [{ name: 'd', key: 'node_modules/d' }]);
});

test('a nested node_modules copy wins over the top-level one', () => {
  const children = graph.children('node_modules/a');
  const b = children.find((c) => c.name === 'b');
  assert.equal(b.key, 'node_modules/a/node_modules/b');
  assert.equal(graph.entry(b.key).version, '2.0.0');
});

test('a dependency with no nested copy walks up to the top-level package', () => {
  const b = graph.children('node_modules/d').find((c) => c.name === 'b');
  assert.equal(b.key, 'node_modules/b');
  assert.equal(graph.entry(b.key).version, '1.0.0');
});

test('an unresolvable dependency has an undefined key (shown as missing)', () => {
  const zzz = graph.children('node_modules/a').find((c) => c.name === 'zzz');
  assert.equal(zzz.key, undefined);
});

test('entry name falls back to the trailing path segment; dev flag is surfaced', () => {
  assert.equal(graph.entry('node_modules/a/node_modules/b').name, 'b');
  assert.equal(graph.entry('node_modules/d').dev, true);
  assert.equal(graph.entry('missing/key'), undefined);
});

test('allPackages excludes the root, workspace links and versionless entries', () => {
  const all = graph.allPackages();
  const labels = all.map((p) => `${p.name}@${p.version}`).sort();
  assert.deepEqual(labels, ['a@1.0.0', 'b@1.0.0', 'b@2.0.0', 'd@3.0.0']);
  assert.equal(all.some((p) => p.name === 'linked'), false);
  assert.equal(all.some((p) => p.name === 'noversion'), false);
});

test('keys() omits the root ("") key', () => {
  assert.equal(graph.keys().includes(''), false);
  assert.ok(graph.keys().includes('node_modules/a'));
});
