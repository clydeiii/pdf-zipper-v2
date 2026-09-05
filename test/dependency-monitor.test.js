import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDependencyChecks,
  resetDependencyStateForTest,
  DEPENDENCY_ALERT_AFTER_FAILURES,
} from '../dist/maintenance/dependency-monitor.js';

// Discord is a no-op without DISCORD_WEBHOOK_URL, so these exercise the state
// machine only: when a dependency counts as down, and that recovery resets it.

function probe(name, answers) {
  let i = 0;
  return { name, check: async () => answers[Math.min(i++, answers.length - 1)] };
}

test('a healthy probe reports healthy with no downSince', async () => {
  resetDependencyStateForTest();
  const [r] = await runDependencyChecks([probe('svc', [null])]);
  assert.equal(r.healthy, true);
  assert.equal(r.error, null);
  assert.equal(r.downSince, null);
});

test('downSince is set on the first failure and cleared on recovery', async () => {
  resetDependencyStateForTest();
  const p = probe('svc', ['timeout', 'timeout', null]);
  let [r] = await runDependencyChecks([p]);
  assert.equal(r.healthy, false);
  assert.equal(r.error, 'timeout');
  assert.ok(r.downSince, 'downSince recorded on first failure');
  const firstDown = r.downSince;
  [r] = await runDependencyChecks([p]);
  assert.equal(r.downSince, firstDown, 'downSince is stable across consecutive failures');
  [r] = await runDependencyChecks([p]);
  assert.equal(r.healthy, true);
  assert.equal(r.downSince, null, 'recovery clears the outage');
});

test('a throwing probe counts as a failure, not a crash', async () => {
  resetDependencyStateForTest();
  const [r] = await runDependencyChecks([{ name: 'svc', check: async () => { throw new Error('boom'); } }]);
  assert.equal(r.healthy, false);
  assert.equal(r.error, 'boom');
});

test('alert threshold is a small number of consecutive failures (a blip stays quiet)', () => {
  assert.ok(DEPENDENCY_ALERT_AFTER_FAILURES >= 2);
});
