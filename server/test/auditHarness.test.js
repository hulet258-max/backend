const test = require("node:test");
const assert = require("node:assert/strict");
const { AuditReport } = require("./audit/report");
const { runStateFuzz } = require("./audit/stateFuzz");

test("managed-game state fuzzer is deterministic and conserves cards", () => {
  const first = runStateFuzz({ sequences: 100, seed: 42 });
  const second = runStateFuzz({ sequences: 100, seed: 42 });
  assert.equal(first.failureCount, 0);
  assert.equal(first.actions, second.actions);
  assert.deepEqual(first.failures, second.failures);
});

test("audit report preserves severity and machine-readable evidence", () => {
  const report = new AuditReport({ smoke: true });
  report.check("safe invariant", true, { roomId: "one" }, "critical");
  report.check("race exposed", false, { statuses: [200, 200] }, "high");
  const data = report.toJSON();
  assert.equal(data.summary.passed, 1);
  assert.equal(data.summary.failed, 1);
  assert.equal(data.summary.high, 1);
  assert.equal(data.findings[0].details.statuses.length, 2);
  assert.match(report.toMarkdown(), /race exposed/);
});

