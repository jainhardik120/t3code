import { assert, it } from "@effect/vitest";

import { pushCategoryForPhase } from "./FcmPushSink.ts";

it("maps alerting phases to their preference category", () => {
  assert.strictEqual(pushCategoryForPhase("waiting_for_approval"), "notifyOnApproval");
  assert.strictEqual(pushCategoryForPhase("waiting_for_input"), "notifyOnInput");
  assert.strictEqual(pushCategoryForPhase("completed"), "notifyOnCompletion");
  assert.strictEqual(pushCategoryForPhase("failed"), "notifyOnFailure");
});

it("returns null for non-alerting phases", () => {
  assert.strictEqual(pushCategoryForPhase("starting"), null);
  assert.strictEqual(pushCategoryForPhase("running"), null);
  assert.strictEqual(pushCategoryForPhase("stale"), null);
});
