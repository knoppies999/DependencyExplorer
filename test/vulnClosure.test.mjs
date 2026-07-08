// vulnClosure.js — computeVulnClosure: the set of graph keys that can reach a directly-vulnerable
// key (the vulnerable node itself, plus every ancestor). Plain reverse reachability, cycle-safe.
// Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { computeVulnClosure } = await import(new URL('vulnClosure.js', OUT));

function closure(adjacency, vulnerable) {
  const vulnSet = new Set(vulnerable);
  return computeVulnClosure(
    Object.keys(adjacency),
    (key) => adjacency[key] ?? [],
    (key) => vulnSet.has(key)
  );
}

test('includes the vulnerable node and all of its ancestors', () => {
  const c = closure({ a: ['b'], b: ['c'], c: [] }, ['c']);
  assert.deepEqual([...c].sort(), ['a', 'b', 'c']);
});

test('excludes subtrees that cannot reach a vulnerability', () => {
  const c = closure({ a: ['b'], b: ['c'], c: [], d: ['e'], e: [] }, ['c']);
  assert.equal(c.has('d'), false);
  assert.equal(c.has('e'), false);
});

test('handles multiple vulnerable nodes and shared ancestors', () => {
  const c = closure({ root: ['a', 'b'], a: ['x'], b: ['y'], x: [], y: [] }, ['x', 'y']);
  assert.deepEqual([...c].sort(), ['a', 'b', 'root', 'x', 'y']);
});

test('is cycle-safe and still flags ancestors (regression guard)', () => {
  // a -> b -> a cycle, and b -> c where c is vulnerable. Both a and b must be flagged.
  const c = closure({ a: ['b'], b: ['a', 'c'], c: [] }, ['c']);
  assert.deepEqual([...c].sort(), ['a', 'b', 'c']);
});

test('empty closure when nothing is vulnerable', () => {
  const c = closure({ a: ['b'], b: [] }, []);
  assert.equal(c.size, 0);
});

test('a vulnerable leaf with no parents is its own closure', () => {
  const c = closure({ solo: [] }, ['solo']);
  assert.deepEqual([...c], ['solo']);
});
