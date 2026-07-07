// Concurrency tests for the bulk-plan parallelism (Fix A). mapWithConcurrency is a module-private
// helper in commands.ts (which imports vscode and can't load under plain node), so we extract the
// compiled function verbatim from out/commands.js and exercise that exact code.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const compiled = fs.readFileSync(new URL('../out/commands.js', import.meta.url), 'utf8');
const start = compiled.indexOf('async function mapWithConcurrency');
assert.ok(start !== -1, 'mapWithConcurrency must exist in the compiled output');
const body = compiled.slice(start, compiled.indexOf('\n}', start) + 2);
const mapWithConcurrency = eval('(' + body.replace('async function mapWithConcurrency', 'async function') + ')');

// The shipped code must actually call it in both bulk planners, or these tests guard nothing.
test('both bulk planners use mapWithConcurrency', () => {
  const uses = compiled.match(/mapWithConcurrency\(jobs, VERSION_FETCH_CONCURRENCY/g) ?? [];
  assert.equal(uses.length, 2, 'buildFixPlan and buildUpdatePlan both fan out through the helper');
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('preserves input order despite out-of-order completion', async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 8, async (i) => { await delay(Math.random() * 20); return i * 10; });
  assert.equal(out.length, 50);
  assert.ok(out.every((v, i) => v === i * 10), 'results line up with inputs');
});

test('never exceeds the concurrency limit, and saturates it', async () => {
  let inFlight = 0, peak = 0;
  await mapWithConcurrency(Array.from({ length: 30 }), 8, async () => {
    inFlight++; peak = Math.max(peak, inFlight); await delay(15); inFlight--;
  });
  assert.ok(peak <= 8, `peak ${peak} <= 8`);
  assert.equal(peak, 8, 'the limit is actually used');
});

test('runs in parallel (24×50ms at limit 8 ≈ 3 waves, not serial)', async () => {
  const started = Date.now();
  await mapWithConcurrency(Array.from({ length: 24 }), 8, async () => delay(50));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `~150ms parallel vs ~1200ms serial (was ${elapsed}ms)`);
});

test('one slow item does not hold up the rest', async () => {
  const started = Date.now();
  const r = await mapWithConcurrency([0, 1, 2, 3], 8, async (i) => { await delay(i === 0 ? 300 : 10); return i; });
  assert.deepEqual(r, [0, 1, 2, 3]);
  assert.ok(Date.now() - started < 450, 'bounded by the single slow item, not the sum');
});

test('edge cases: empty input and limit greater than item count', async () => {
  assert.deepEqual(await mapWithConcurrency([], 8, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 8, async (x) => x + 1), [2, 3]);
});
