import assert from "node:assert/strict";
import path from "node:path";
import { createLayaSidecarRunner } from "../src/laya-worker.js";
import { LAYA_TARGET_CATALOGUE } from "../src/laya-targets.js";
const runner = createLayaSidecarRunner({ executable: path.resolve(process.argv[2]), threads: 1 });
try {
  const status = await runner.status();
  assert.equal(status.available, true);
  assert.ok(status.capabilities.includes("value-groups-v1"));
  const result = await runner.evaluate({ decisions: [{ id: "smoke", kind: "classify", target: { id: "sourceIp", ...LAYA_TARGET_CATALOGUE.sourceIp }, field: { id: "f0", key: "sourceIp", ancestry: ["documents", "0"], value: "203.0.113.8" } }] });
  assert.equal(result.results[0].id, "smoke");
  assert.ok(Number.isFinite(result.results[0].score));
  assert.equal(result.runtime.ready, true);
  assert.equal(result.runtime.device, "cpu");
  console.log(JSON.stringify({ status, result }));
} finally { runner.close(); }
