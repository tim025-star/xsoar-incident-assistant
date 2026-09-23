import assert from "node:assert/strict";
import path from "node:path";

import { LAYA_MODEL, LAYA_TARGET_CATALOGUE } from "../src/laya-targets.js";
import { createLayaSidecarRunner } from "../src/laya-worker.js";

const [runtimeExecutable, modelDirectory] = process.argv.slice(2).map((value) => value && path.resolve(value));
if (!runtimeExecutable || !modelDirectory) throw new Error("Usage: node scripts/smoke-laya-pilot.mjs <runtime.exe> <model-directory>");
const runner = createLayaSidecarRunner({
  executable: runtimeExecutable,
  threads: 1,
  timeoutMs: 300000,
  env: { LAYA_MODEL_PATH: modelDirectory, LAYA_MAPPER_ROOT: path.dirname(path.dirname(modelDirectory)) }
});
try {
  const status = await runner.status();
  assert.equal(status.available, true);
  assert.deepEqual(status.model, LAYA_MODEL);
  const response = await runner.evaluate({ decisions: [{
    id: "pilot-smoke-source-ip",
    kind: "classify",
    target: LAYA_TARGET_CATALOGUE.sourceIp,
    field: {
      id: "f-pilot-smoke-source-ip",
      pointer: "/documents/0/sourceIp",
      key: "sourceIp",
      ancestry: ["documents", "0"],
      value: "203.0.113.8",
      context: [],
      omittedSiblings: 0,
      shortenedSiblings: 0
    }
  }] });
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].id, "pilot-smoke-source-ip");
  assert.equal(Number.isFinite(response.results[0].score), true);
  assert.equal(response.runtime.model.revision, LAYA_MODEL.revision);
  console.log(JSON.stringify({ ok: true, model: status.model, score: response.results[0].score }));
} finally {
  runner.close();
}
