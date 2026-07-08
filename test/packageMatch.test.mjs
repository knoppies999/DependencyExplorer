// packageMatch.js — case-insensitive, wildcard package-name matching backing the prefer-latest /
// never-update lists. Pure, vscode-free.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const { matchesAnyPattern } = await import(new URL('packageMatch.js', OUT));

test('exact match is case-insensitive', () => {
  assert.equal(matchesAnyPattern('Lodash', ['lodash']), true);
  assert.equal(matchesAnyPattern('lodash', ['LODASH']), true);
  assert.equal(matchesAnyPattern('lodash-es', ['lodash']), false);
});

test('a scope wildcard matches every package in the scope', () => {
  assert.equal(matchesAnyPattern('@myorg/utils', ['@myorg/*']), true);
  assert.equal(matchesAnyPattern('@myorg/deep/thing', ['@myorg/*']), true);
  assert.equal(matchesAnyPattern('@other/utils', ['@myorg/*']), false);
});

test('a bare * matches anything', () => {
  assert.equal(matchesAnyPattern('literally-anything', ['*']), true);
});

test('blank and whitespace-only patterns are ignored', () => {
  assert.equal(matchesAnyPattern('x', ['', '   ']), false);
  // ...but a real pattern alongside blanks still matches.
  assert.equal(matchesAnyPattern('x', ['', 'x']), true);
});

test('any matching pattern in the list wins', () => {
  assert.equal(matchesAnyPattern('react', ['vue', 'react', 'svelte']), true);
  assert.equal(matchesAnyPattern('react', ['vue', 'svelte']), false);
});

test('dots are literal, not regex "any character"', () => {
  assert.equal(matchesAnyPattern('lodash.merge', ['lodash.merge']), true);
  assert.equal(matchesAnyPattern('lodashXmerge', ['lodash.merge']), false);
});

test('patterns are trimmed before matching', () => {
  assert.equal(matchesAnyPattern('lodash', ['  lodash  ']), true);
});

test('empty pattern list never matches', () => {
  assert.equal(matchesAnyPattern('anything', []), false);
});
