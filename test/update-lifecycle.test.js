import test from "node:test";
import assert from "node:assert/strict";
import { claimUpdate, completeUpdate, releaseUpdate } from "../src/update-lifecycle.js";

function databaseStub({ changes = 1, status = "processing" } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async run() { calls.push({ type: "run", sql, values: this.values }); return { meta: { changes } }; },
        async first() { calls.push({ type: "first", sql, values: this.values }); return { status }; }
      };
      return statement;
    }
  };
}

test("a new webhook update receives a processing lease", async () => {
  const database = databaseStub();
  const context = await claimUpdate(database, 123, 1000);
  assert.equal(context.state, "claimed");
  assert.equal(context.updateId, 123);
  assert.ok(context.leaseToken);
  assert.deepEqual(database.calls[0].values.slice(0, 2), [123, 1000]);
  assert.equal(database.calls[0].values[3], 1180);
});

test("completed and in-flight duplicate updates are distinguished", async () => {
  const done = await claimUpdate(databaseStub({ changes: 0, status: "done" }), 10, 1000);
  const busy = await claimUpdate(databaseStub({ changes: 0, status: "processing" }), 11, 1000);
  assert.equal(done.state, "done");
  assert.equal(busy.state, "busy");
});

test("completing an update requires the matching lease", async () => {
  const context = { updateId: 20, leaseToken: "lease" };
  const database = databaseStub();
  await completeUpdate(database, context);
  assert.deepEqual(database.calls[0].values, [20, "lease"]);
  await assert.rejects(
    completeUpdate(databaseStub({ changes: 0 }), context),
    /completion lease lost/
  );
});

test("failed pre-commit updates are released for retry", async () => {
  const database = databaseStub();
  const context = { updateId: 30, leaseToken: "lease" };
  await releaseUpdate(database, context, new Error("temporary\nerror"));
  assert.deepEqual(database.calls[0].values, ["temporary error", 30, "lease"]);
});
