// pnpmGraph.js — buildPnpmGraphs parses pnpm-lock.yaml (v6 / v9 / pnpm-11 multi-doc) into one
// resolved graph per importer. Pure, vscode-free (uses the `yaml` dependency).
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/providers/', import.meta.url);
const { buildPnpmGraphs } = await import(new URL('pnpmGraph.js', OUT));

// A v9 workspace lockfile: importer `.` depends on `a` (prod) and `d` (dev); `a` pulls in `b` and a
// scoped, peer-annotated package to exercise the key parser.
const v9 = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      d:
        specifier: ^3.0.0
        version: 3.0.0
snapshots:
  a@1.0.0:
    dependencies:
      b: 2.0.0
      '@scope/pkg': 1.2.3(react@18.0.0)
  b@2.0.0: {}
  '@scope/pkg@1.2.3(react@18.0.0)': {}
  d@3.0.0: {}
`;

test('parses a v9 workspace into one graph per importer', () => {
  const graphs = buildPnpmGraphs(v9);
  assert.equal(graphs.length, 1);
  assert.equal(graphs[0].importerPath, '.');
});

test('resolves direct prod/dev deps to snapshot keys', () => {
  const { graph } = buildPnpmGraphs(v9)[0];
  assert.deepEqual(graph.directProd, [{ name: 'a', key: 'a@1.0.0' }]);
  assert.deepEqual(graph.directDev, [{ name: 'd', key: 'd@3.0.0' }]);
});

test('resolves transitive edges, including a scoped peer-annotated key', () => {
  const { graph } = buildPnpmGraphs(v9)[0];
  const children = graph.children('a@1.0.0');
  assert.deepEqual(children.find((c) => c.name === 'b'), { name: 'b', key: 'b@2.0.0' });
  assert.deepEqual(
    children.find((c) => c.name === '@scope/pkg'),
    { name: '@scope/pkg', key: '@scope/pkg@1.2.3(react@18.0.0)' }
  );
});

test('parses name/version out of keys (strips peer suffix and scope @)', () => {
  const { graph } = buildPnpmGraphs(v9)[0];
  assert.deepEqual(graph.entry('a@1.0.0'), { name: 'a', version: '1.0.0' });
  assert.deepEqual(graph.entry('@scope/pkg@1.2.3(react@18.0.0)'), { name: '@scope/pkg', version: '1.2.3' });
});

test('scopes the importer to only its reachable packages', () => {
  const { graph } = buildPnpmGraphs(v9)[0];
  const keys = graph.keys().sort();
  assert.deepEqual(keys, ['@scope/pkg@1.2.3(react@18.0.0)', 'a@1.0.0', 'b@2.0.0', 'd@3.0.0']);
  assert.equal(graph.allPackages().length, 4);
});

test('supports a non-workspace v9 lockfile (top-level dependencies)', () => {
  const flat = `
lockfileVersion: '9.0'
dependencies:
  a:
    specifier: ^1.0.0
    version: 1.0.0
snapshots:
  a@1.0.0: {}
`;
  const graphs = buildPnpmGraphs(flat);
  assert.equal(graphs.length, 1);
  assert.deepEqual(graphs[0].graph.directProd, [{ name: 'a', key: 'a@1.0.0' }]);
});

test('throws a friendly error for an unsupported lockfile version', () => {
  assert.throws(() => buildPnpmGraphs(`lockfileVersion: '5'\ndependencies: {}\n`), /not supported/i);
});
