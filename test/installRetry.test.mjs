// installRetry.js — recognises an npm/pnpm peer-dependency conflict and offers the right escape
// hatch flag. Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { isPeerConflict, peerDepsRetryFlag } = await import(new URL('installRetry.js', OUT));

test('isPeerConflict recognises ERESOLVE / peer-conflict output', () => {
  assert.equal(isPeerConflict('npm ERR! code ERESOLVE'), true);
  assert.equal(isPeerConflict('npm ERR! Could not resolve dependency:'), true);
  assert.equal(isPeerConflict('conflicting peer dependency react@18'), true);
  assert.equal(isPeerConflict('ERESOLVE'.toLowerCase()), true);
});

test('isPeerConflict is false for unrelated failures', () => {
  assert.equal(isPeerConflict('ENOENT: no such file'), false);
  assert.equal(isPeerConflict('network timeout'), false);
  assert.equal(isPeerConflict(''), false);
});

test('peerDepsRetryFlag returns the manager-specific flag', () => {
  assert.equal(peerDepsRetryFlag('npm install'), '--legacy-peer-deps');
  assert.equal(peerDepsRetryFlag('pnpm install'), '--no-strict-peer-dependencies');
});

test('peerDepsRetryFlag is undefined for managers without the concept', () => {
  assert.equal(peerDepsRetryFlag('dotnet restore'), undefined);
});

test('peerDepsRetryFlag matches the manager as a whole word, not a substring', () => {
  // "npmish" must not be treated as npm.
  assert.equal(peerDepsRetryFlag('npmish frobnicate'), undefined);
});
