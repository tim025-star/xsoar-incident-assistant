import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createLayaMapper } from "../src/laya-mapper.js";
import { createLayaSidecarRunner, createLayaWorkerPool } from "../src/laya-worker.js";
import { LAYA_MAPPER_TARGETS } from "../src/laya-targets.js";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sourcePath = path.resolve(option("--source", ""));
const executable = path.resolve(option("--runner", ""));
const modelPath = path.resolve(option("--model", ""));
const output = path.resolve(option("--output", "artifacts/laya-training/production-evaluation.json"));
const split = option("--split", "frozen-test");
const runs = Number(option("--runs", "2"));
if (!sourcePath || !executable || !modelPath || !["development", "frozen-test"].includes(split) || !Number.isInteger(runs) || runs < 1) {
  throw new Error("Usage: evaluate-laya-reviewed-sources --source <approved.jsonl> --runner <exe> --model <checkpoint> [--split development|frozen-test] [--runs 2]");
}
const sourceText = await readFile(sourcePath, "utf8");
const records = sourceText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.split === split);
if (!records.length) throw new Error(`No reviewed ${split} records were supplied.`);
const families = new Set(records.map((row) => row.splitUnit.templateFamily));
const report = {
  schemaVersion: 1,
  metricScope: "full-production-mapper",
  source: sourcePath,
  sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
  split,
  records: records.length,
  families: families.size,
  productionTargets: LAYA_MAPPER_TARGETS.length,
  runs,
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
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, records: report.records, families: report.families, metrics: report.metrics, savedReloadPredictionEquality: report.savedReloadPredictionEquality }));
