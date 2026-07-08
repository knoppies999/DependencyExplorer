// fixPlanner.js — nearestSafeVersion, the core of "Fix All Vulnerabilities": the smallest bump above
// the current version that the safety predicate accepts, preferring stable over prerelease. Driven
// here with the real compareVersionsDesc / isPrerelease from registryService. Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { nearestSafeVersion } = await import(new URL('fixPlanner.js', OUT));
const { compareVersionsDesc, isPrerelease } = await import(new URL('registryService.js', OUT));

// versionsDesc is the registry list newest-first, exactly as fetchVersions returns it.
const near = (versionsDesc, current, safe) =>
  nearestSafeVersion(versionsDesc, current, safe, compareVersionsDesc, isPrerelease);

test('picks the nearest safe version strictly newer than current', () => {
  const versions = ['2.0.0', '1.5.0', '1.4.0', '1.3.0', '1.2.0'];
  const safe = (v) => v === '1.4.0' || v === '2.0.0';
  assert.equal(near(versions, '1.2.0', safe), '1.4.0');
});

test('never targets the current version or older', () => {
  const versions = ['1.3.0', '1.2.0', '1.1.0'];
  // Only 1.1.0 (older) is "safe" — there is no safe upgrade.
  assert.equal(near(versions, '1.2.0', (v) => v === '1.1.0'), undefined);
});

test('prefers a stable release even when a nearer prerelease is also safe', () => {
  const versions = ['1.5.0', '1.4.0-rc.1', '1.3.0'];
  const safe = () => true;
  assert.equal(near(versions, '1.3.0', safe), '1.5.0', 'skips the nearer prerelease for the stable one');
});

test('falls back to a prerelease when no stable candidate is safe', () => {
  const versions = ['1.5.0-rc.1', '1.4.0', '1.3.0'];
  // 1.4.0 (the only stable upgrade) is unsafe; the prerelease is the only safe option.
  const safe = (v) => v === '1.5.0-rc.1';
  assert.equal(near(versions, '1.3.0', safe), '1.5.0-rc.1');
});

test('returns undefined when nothing newer is safe', () => {
  const versions = ['1.3.0', '1.2.0'];
  assert.equal(near(versions, '1.2.0', () => false), undefined);
});

test('returns undefined when current is already the newest', () => {
  const versions = ['1.2.0', '1.1.0'];
  assert.equal(near(versions, '1.2.0', () => true), undefined);
});

test('walks up to the smallest safe bump among several safe candidates', () => {
  const versions = ['3.0.0', '2.0.0', '1.5.0', '1.0.0'];
  const safe = (v) => v === '2.0.0' || v === '3.0.0';
  assert.equal(near(versions, '1.0.0', safe), '2.0.0', 'nearest, not newest');
});
