import test from "node:test";
import assert from "node:assert/strict";

import { assertStableRuntimeIdentity, caseTargetSetSha256, runtimeContract } from "../scripts/laya-evaluation-identity.mjs";

const runtime = {
  protocolVersion: 2, sdkVersion: "0.3.5",
  model: { id: "base-english", repository: "convaiinnovations/laya", revision: "revision", sdkVersion: "0.3.5" },
  promptVersion: "english-fields-v3", effectiveWorkers: 1, threadsPerWorker: 8, workerMode: "manual", requestedWorkers: 1
};

test("evaluation identity binds exact case-target sets independent of ordering", () => {
  const left = caseTargetSetSha256([{ id: "b", targets: ["sourceIp"] }, { id: "a", targets: ["clientIp", "occurred"] }]);
  const right = caseTargetSetSha256([{ id: "a", targets: ["occurred", "clientIp"] }, { id: "b", targets: ["sourceIp"] }]);
  assert.equal(left, right);
  assert.notEqual(left, caseTargetSetSha256([{ id: "a", targets: ["clientIp"] }, { id: "b", targets: ["sourceIp"] }]));
});

test("evaluation runtime identity rejects stale prompt, worker and thread contracts", () => {
  const expected = runtimeContract(runtime);
  assert.doesNotThrow(() => assertStableRuntimeIdentity(expected, runtime));
  for (const changed of [
    { ...runtime, promptVersion: "english-fields-v2" },
    { ...runtime, effectiveWorkers: 2 },
    { ...runtime, threadsPerWorker: 4 }
  ]) assert.throws(() => assertStableRuntimeIdentity(expected, changed), /identity changed/i);
});
