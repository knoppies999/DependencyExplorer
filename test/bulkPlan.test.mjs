// Guard tests for the "bulk operations only touch direct dependencies" behaviour. The planners live
// in commands.ts (which imports vscode and can't load under plain node), so — like the concurrency
// test — we assert against the compiled out/commands.js source. These lock in the skip-transitive
// contract so a refactor can't silently start fetching/pinning the whole transitive tree again.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const compiled = fs.readFileSync(new URL('../out/commands.js', import.meta.url), 'utf8');

test('both bulk planners skip transitive packages (except prefer-latest)', () => {
  // buildFixPlan skips a vulnerable transitive; buildUpdatePlan skips a transitive package.
  // The matchesAnyPattern call is namespaced in the compiled output ((0, packageMatch_1.matchesAnyPattern)),
  // so allow any call expression between the `!` and the identifier.
  assert.ok(
    /!\s*vuln\.isDirect\s*&&\s*![^;{]*matchesAnyPattern/.test(compiled),
    'buildFixPlan guards transitive vulns behind the prefer-latest exception'
  );
  assert.ok(
    /!\s*pkg\.isDirect\s*&&\s*![^;{]*matchesAnyPattern/.test(compiled),
    'buildUpdatePlan guards transitive packages behind the prefer-latest exception'
  );
});

test('skipped transitives are collected, not fetched', () => {
  assert.ok(compiled.includes('skippedTransitive.add(vuln.name)'), 'fix plan records skipped transitive vulns');
  assert.ok(compiled.includes('skippedTransitive.add(pkg.name)'), 'update plan records skipped transitives');
});

test('the user is told which transitives were skipped, in both flows', () => {
  assert.ok(
    /reportSkippedTransitive\(\s*skippedTransitive\s*,\s*['"]fix['"]\s*\)/.test(compiled),
    'Fix All reports skipped transitive vulns'
  );
  assert.ok(
    /reportSkippedTransitive\(\s*skippedTransitive\s*,\s*['"]update['"]\s*\)/.test(compiled),
    'Update All reports skipped transitives'
  );
});
