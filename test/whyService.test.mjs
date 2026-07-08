// whyService.js — findDependencyPaths: every chain from a project's direct deps down to a target
// package ("why is this here?"). Operates on the provider-agnostic GraphAccess, so we drive it with
// a plain in-memory graph. Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { findDependencyPaths } = await import(new URL('whyService.js', OUT));

// Build a GraphAccess from an adjacency map. Keys double as names; versions default to 1.0.0.
// roots: array of [key, isDev].
function graphOf(adjacency, roots, versions = {}) {
  const keys = Object.keys(adjacency);
  return {
    roots: roots.map(([key, isDev]) => ({ key, isDev: !!isDev })),
    entry: (key) => (key in adjacency ? { name: key, version: versions[key] ?? '1.0.0' } : undefined),
    childKeys: (key) => adjacency[key] ?? [],
    keys: () => keys,
  };
}

const names = (path) => path.steps.map((s) => s.name);

test('enumerates each chain from a direct dep down to the target', () => {
  const g = graphOf(
    { a: ['b'], b: ['c'], c: [], d: ['c'] },
    [['a', false], ['d', true]]
  );
  const r = findDependencyPaths(g, 'c');
  const paths = r.paths.map(names);
  assert.deepEqual(paths, [['d', 'c'], ['a', 'b', 'c']], 'shortest chain first');
  assert.equal(r.truncated, false);
});

test('tags a chain that starts at a dev dependency', () => {
  const g = graphOf({ a: ['c'], c: [] }, [['a', true]]);
  const r = findDependencyPaths(g, 'c');
  assert.equal(r.paths.length, 1);
  assert.equal(r.paths[0].isDev, true);
});

test('returns no paths when the target is not in the graph', () => {
  const g = graphOf({ a: ['b'], b: [] }, [['a', false]]);
  assert.deepEqual(findDependencyPaths(g, 'nope'), { paths: [], truncated: false, targetVersions: [] });
});

test('is cycle-safe (a -> b -> a, b -> c)', () => {
  const g = graphOf({ a: ['b'], b: ['a', 'c'], c: [] }, [['a', false]]);
  const r = findDependencyPaths(g, 'c');
  assert.deepEqual(r.paths.map(names), [['a', 'b', 'c']]);
});

test('reports every distinct resolved version of the target', () => {
  // Two graph keys both named "c" but at different versions.
  const adjacency = { a: ['c1'], b: ['c2'], c1: [], c2: [] };
  const g = {
    roots: [{ key: 'a', isDev: false }, { key: 'b', isDev: false }],
    entry: (k) => ({ a: { name: 'a', version: '1.0.0' }, b: { name: 'b', version: '1.0.0' }, c1: { name: 'c', version: '1.0.0' }, c2: { name: 'c', version: '2.0.0' } })[k],
    childKeys: (k) => adjacency[k] ?? [],
    keys: () => Object.keys(adjacency),
  };
  const r = findDependencyPaths(g, 'c');
  assert.deepEqual(r.targetVersions, ['1.0.0', '2.0.0']);
  assert.equal(r.paths.length, 2);
});

test('truncates at maxPaths and flags it', () => {
  const g = graphOf({ a: ['t'], b: ['t'], c: ['t'], t: [] }, [['a', false], ['b', false], ['c', false]]);
  const r = findDependencyPaths(g, 't', 2);
  assert.equal(r.paths.length, 2);
  assert.equal(r.truncated, true);
});

test('a direct dependency that IS the target yields a single-step path', () => {
  const g = graphOf({ t: [] }, [['t', false]]);
  const r = findDependencyPaths(g, 't');
  assert.deepEqual(r.paths.map(names), [['t']]);
});
