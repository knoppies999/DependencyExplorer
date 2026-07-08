// registryService.js version helpers: compareVersionsDesc (newest-first ordering, used everywhere a
// version list is sorted) and isPrerelease. Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { compareVersionsDesc, isPrerelease } = await import(new URL('registryService.js', OUT));

test('sorts newest-first numerically (not lexically)', () => {
  const sorted = ['1.0.0', '1.2.0', '1.10.0', '1.2.1'].sort(compareVersionsDesc);
  assert.deepEqual(sorted, ['1.10.0', '1.2.1', '1.2.0', '1.0.0']);
});

test('handles 4-part NuGet versions', () => {
  const sorted = ['1.2.3.4', '1.2.3.5', '1.2.4.0', '1.3.0.0'].sort(compareVersionsDesc);
  assert.deepEqual(sorted, ['1.3.0.0', '1.2.4.0', '1.2.3.5', '1.2.3.4']);
});

test('stable releases sort ahead of prereleases of the same core version', () => {
  const sorted = ['1.0.0-rc.1', '1.0.0', '1.0.0-alpha'].sort(compareVersionsDesc);
  assert.equal(sorted[0], '1.0.0', 'stable is newest');
  assert.deepEqual(sorted, ['1.0.0', '1.0.0-rc.1', '1.0.0-alpha']);
});

test('orders two prereleases of the same core version, newest-first', () => {
  const sorted = ['1.0.0-rc.1', '1.0.0-rc.2'].sort(compareVersionsDesc);
  assert.deepEqual(sorted, ['1.0.0-rc.2', '1.0.0-rc.1']);
});

test('returns 0 for equal versions', () => {
  assert.equal(compareVersionsDesc('1.2.3', '1.2.3'), 0);
});

test('missing trailing parts are treated as zero', () => {
  assert.equal(compareVersionsDesc('1.2', '1.2.0'), 0);
});

test('isPrerelease detects a dash-suffixed version only', () => {
  assert.equal(isPrerelease('1.0.0-rc.1'), true);
  assert.equal(isPrerelease('1.0.0-alpha'), true);
  assert.equal(isPrerelease('1.0.0'), false);
  assert.equal(isPrerelease('1.0.0+build.5'), false);
});
