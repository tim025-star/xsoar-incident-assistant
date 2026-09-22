import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLayaMapper } from "../src/laya-mapper.js";
import { createLayaSidecarRunner, createLayaWorkerPool } from "../src/laya-worker.js";
import { LAYA_MAPPER_TARGETS } from "../src/laya-targets.js";
import { assertStableRuntimeIdentity, caseTargetSetSha256, fileSha256, implementationSha256, runtimeContract } from "./laya-evaluation-identity.mjs";

const args = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sourceOption = option("--source", "");
const runnerOption = option("--runner", "");
const modelOption = option("--model", "");
const sourcePath = path.resolve(sourceOption || ".");
const executable = path.resolve(runnerOption || ".");
const modelPath = path.resolve(modelOption || ".");
const output = path.resolve(option("--output", "artifacts/laya-training/production-evaluation.json"));
const split = option("--split", "frozen-test");
const runs = Number(option("--runs", "2"));
const checkpointManifestOption = option("--checkpoint-manifest", "");
const checkpointWeightsOption = option("--checkpoint-weights", path.join(modelPath, "model.safetensors"));
if (!sourceOption || !runnerOption || !modelOption || !checkpointManifestOption || !["development", "frozen-test"].includes(split) || !Number.isInteger(runs) || runs < 2) {
  throw new Error("Usage: evaluate-laya-reviewed-sources --source <approved.jsonl> --runner <exe> --model <checkpoint> --checkpoint-manifest <json> [--checkpoint-weights <safetensors>] [--split development|frozen-test] [--runs 2]");
}
if (path.resolve(checkpointWeightsOption) !== path.join(modelPath, "model.safetensors")) throw new Error("Checkpoint weights identity must name the model directory's model.safetensors.");
const sourceText = await readFile(sourcePath, "utf8");
const records = sourceText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.split === split);
if (!records.length) throw new Error(`No reviewed ${split} records were supplied.`);
if (new Set(records.map((record) => record.sampleId)).size !== records.length) throw new Error("Reviewed evaluation source contains duplicate sample IDs.");
const families = new Set(records.map((row) => row.splitUnit.templateFamily));
const report = {
  schemaVersion: 2,
  metricScope: "full-production-mapper",
  source: sourcePath,
  sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
  split,
  records: records.length,
  families: families.size,
  productionTargets: LAYA_MAPPER_TARGETS.length,
  runs,
  expectedRuns: runs,
  caseTargetSetSha256: caseTargetSetSha256(records.map((record) => ({ sampleId: record.sampleId, targets: LAYA_MAPPER_TARGETS }))),
  implementationSha256: await implementationSha256(root, "scripts/evaluate-laya-reviewed-sources.mjs"),
  checkpoint: { manifestSha256: await fileSha256(path.resolve(checkpointManifestOption)), weightsSha256: await fileSha256(path.resolve(checkpointWeightsOption)) },
  runtimeArtifactSha256: await fileSha256(executable),
  cases: []
};
await mkdir(path.dirname(output), { recursive: true });
try {
  for (let run = 1; run <= runs; run++) {
    const runner = createLayaWorkerPool({ runnerFactory: (settings) => createLayaSidecarRunner({
      ...settings, executable, env: { LAYA_MODEL_PATH: modelPath }
    }) });
    const mapper = createLayaMapper({ runner });
    try {
      for (const record of records) {
        const targets = LAYA_MAPPER_TARGETS;
        const result = await mapper.mapIncident({ documents: record.documents, targets, experiment: "grouped", workerMode: "auto", workerCount: 1 });
        const identity = runtimeContract(result.runtime);
        if (!report.runtime) report.runtime = identity;
        else assertStableRuntimeIdentity(report.runtime, result.runtime);
        const outcomes = targets.map((target) => {
          const expected = record.decisions[target];
          const actual = result.paths[target] || null;
          const scored = expected.state !== "unlabelled";
          const accepted = !scored ? null : expected.state === "mapped" ? expected.acceptedPointers.includes(actual) : actual === null && result.statuses[target] === "no_supported_match";
          return {
            target,
            expectedState: expected.state,
            expectedPointers: expected.acceptedPointers || [],
            actual,
            status: result.statuses[target],
            scored,
            accepted,
            falseAbsentMapping: expected.state === "absent" && actual !== null,
            missed: expected.state === "mapped" && actual === null,
          };
        });
        report.cases.push({ sampleId: record.sampleId, sourceFamily: record.sourceFamily, templateFamily: record.splitUnit.templateFamily, run, outcomes, processingComplete: result.processingComplete, coverage: result.coverage });
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
      }
    } finally {
      mapper.close();
    }
  }
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  throw error;
}
const rows = report.cases.flatMap((entry) => entry.outcomes).filter((row) => row.scored);
const count = (predicate) => rows.filter(predicate).length;
report.metrics = {
  targets: rows.length,
  accepted: count((row) => row.accepted),
  falseAbsentMappings: count((row) => row.falseAbsentMapping),
  missed: count((row) => row.missed),
  incompleteRuns: report.cases.filter((entry) => !entry.processingComplete).length,
  coverageFailures: report.cases.reduce((total, entry) => total
    + (entry.outcomes.length === LAYA_MAPPER_TARGETS.length && Object.keys(entry.coverage).length === LAYA_MAPPER_TARGETS.length ? 0 : 1)
    + Object.values(entry.coverage).filter((coverage) => coverage.scored !== coverage.eligible || coverage.finalAssessed !== coverage.eligible).length, 0),
};
const byKey = new Map();
for (const entry of report.cases) {
  for (const outcome of entry.outcomes) {
    const key = JSON.stringify([entry.sampleId, outcome.target]);
    const value = JSON.stringify([outcome.actual, outcome.status]);
    if (byKey.has(key) && byKey.get(key) !== value) throw new Error(`Non-deterministic saved/reloaded production output for ${key}.`);
    byKey.set(key, value);
  }
}
report.savedReloadPredictionEquality = runs > 1;
report.modelReloadPasses = runs;
if (report.cases.length !== records.length * runs) throw new Error("Frozen evaluation report has an unexpected case/run count.");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, records: report.records, families: report.families, metrics: report.metrics, savedReloadPredictionEquality: report.savedReloadPredictionEquality }));
