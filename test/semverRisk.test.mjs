// semverRisk.js — classifies a version bump as major/minor/patch/prerelease/unknown for the risk
// badges. Tolerant of NuGet 4-part versions and prerelease suffixes. Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { bumpRisk, riskBadge, riskLabel } = await import(new URL('semverRisk.js', OUT));

test('bumpRisk classifies the changed semver level', () => {
  assert.equal(bumpRisk('1.0.0', '2.0.0'), 'major');
  assert.equal(bumpRisk('1.2.0', '1.3.0'), 'minor');
  assert.equal(bumpRisk('1.2.3', '1.2.4'), 'patch');
  // Direction-agnostic: a downgrade is classified the same way.
  assert.equal(bumpRisk('2.0.0', '1.0.0'), 'major');
});

test('bumpRisk treats a NuGet 4th-part (revision) change as patch', () => {
  assert.equal(bumpRisk('1.2.3.4', '1.2.3.5'), 'patch');
  assert.equal(bumpRisk('1.2.3.4', '1.2.4.0'), 'patch');
  assert.equal(bumpRisk('1.2.3.4', '1.3.0.0'), 'minor');
});

test('bumpRisk detects a prerelease-only change', () => {
  assert.equal(bumpRisk('1.2.3-alpha', '1.2.3'), 'prerelease');
  assert.equal(bumpRisk('1.2.3-alpha', '1.2.3-beta'), 'prerelease');
  // A core-version change dominates the prerelease suffix.
  assert.equal(bumpRisk('1.2.3-alpha', '1.3.0'), 'minor');
});

test('bumpRisk returns unknown for unparseable input', () => {
  assert.equal(bumpRisk('not-a-version', '1.0.0'), 'unknown');
  assert.equal(bumpRisk('1.0.0', 'latest'), 'unknown');
});

test('riskBadge maps each level to its badge text ("" for unknown)', () => {
  assert.equal(riskBadge('major'), '⚠ major');
  assert.equal(riskBadge('minor'), 'minor');
  assert.equal(riskBadge('patch'), 'patch');
  assert.equal(riskBadge('prerelease'), 'pre-release');
  assert.equal(riskBadge('unknown'), '');
});

test('riskLabel gives a human sentence, empty for unknown', () => {
  assert.match(riskLabel('major'), /breaking/i);
  assert.equal(riskLabel('unknown'), '');
});
