import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { caseTargetSetSha256, fileSha256, implementationSha256, sha256 } from "../../scripts/laya-evaluation-identity.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..", "..");

test("promotion verification rejects stale or mislabeled case-target reports", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laya-promotion-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = path.join(directory, "artifact.bin");
  const source = path.join(directory, "source.jsonl");
  await writeFile(artifact, "exact artifact");
  await writeFile(source, "{}\n");
  const artifactHash = await fileSha256(artifact);
  const checkpoint = { manifestSha256: artifactHash, weightsSha256: artifactHash };
  const runtime = {
    protocolVersion: 2, sdkVersion: "0.3.5", model: { id: "base-english", repository: "convaiinnovations/laya", revision: "r", sdkVersion: "0.3.5" },
    promptVersion: "english-fields-v3", effectiveWorkers: 1, threadsPerWorker: 1, workerMode: "manual", requestedWorkers: 1
  };
  const corpus = path.join(root, "test/fixtures/laya-baseline-cases.json");
  const fixed = {
    schemaVersion: 3, corpus, corpusSha256: sha256(await readFile(corpus)), split: "evaluation", workers: 1,
    experiments: ["grouped"], expectedRuns: 1, selectedCaseCount: 1, caseTargetSetSha256: "0".repeat(64),
    implementationSha256: await implementationSha256(root, "scripts/evaluate-laya-mapper.mjs"), checkpoint,
    runtimeArtifactSha256: artifactHash, runtime, cases: [{ id: "case", runtimeState: "warm", targets: [{ target: "sourceIp" }], result: { timings: { totalMs: 1 }, runtime: { peakWorkingSetBytes: 1 } } }],
    byExperiment: { grouped: { targets: 47, accepted: 24, falseAbsentMappings: 0, incompleteRuns: 0, disagreements: 0 } }
  };
  const targets = Array.from({ length: 23 }, (_, index) => `target-${index}`);
  const frozenCases = [1, 2].map((run) => ({ sampleId: "sample", run, outcomes: targets.map((target) => ({ target })), coverage: {}, processingComplete: true }));
  const frozen = {
    schemaVersion: 2, metricScope: "full-production-mapper", split: "frozen-test", source, sourceSha256: sha256(await readFile(source)), records: 1, families: 1,
    productionTargets: 23, expectedRuns: 2, runs: 2, caseTargetSetSha256: caseTargetSetSha256([{ sampleId: "sample", targets }]),
    implementationSha256: await implementationSha256(root, "trainer/scripts/evaluate-laya-reviewed-sources.mjs"), checkpoint,
    runtimeArtifactSha256: artifactHash, runtime: { ...runtime, workerMode: "auto" }, cases: frozenCases,
    metrics: { accepted: 1, falseAbsentMappings: 0, incompleteRuns: 0, coverageFailures: 0 }, savedReloadPredictionEquality: true, modelReloadPasses: 2
  };
  const robustness = { ...fixed, byExperiment: { grouped: { targets: 19, accepted: 8, falseAbsentMappings: 0, incompleteRuns: 0, disagreements: 0 } } };
  const fixedCandidate = structuredClone(fixed);
  fixedCandidate.cases[0].result.timings.totalMs = 2;
  fixedCandidate.cases[0].result.runtime.peakWorkingSetBytes = 2;
  fixedCandidate.byExperiment.grouped.accepted = 25;
  const files = {};
  for (const [name, value] of Object.entries({ frozenBase: frozen, frozenCandidate: frozen, fixedBase: fixed, fixedCandidate, robustness })) {
    files[name] = path.join(directory, `${name}.json`);
    await writeFile(files[name], JSON.stringify(value));
  }
  const args = ["trainer/scripts/verify-laya-promotion.mjs",
    "--frozen-base", files.frozenBase, "--frozen-candidate", files.frozenCandidate,
    "--fixed-base", files.fixedBase, "--fixed-candidate", files.fixedCandidate, "--robustness-candidate", files.robustness,
    "--frozen-source", source, "--fixed-corpus", corpus, "--robustness-corpus", corpus,
    "--base-checkpoint-manifest", artifact, "--base-checkpoint-weights", artifact,
    "--candidate-checkpoint-manifest", artifact, "--candidate-checkpoint-weights", artifact, "--runtime-artifact", artifact,
    "--output", path.join(directory, "result.json")];
  await assert.rejects(execute(process.execPath, args, { cwd: root }), (error) => {
    assert.match(error.stdout, /case-target set hash is stale or mislabeled/i);
    assert.match(error.stdout, /warm runtime regresses by more than 15% without an exact reviewed justification/i);
    assert.match(error.stdout, /peak RAM regresses by more than 15% without an exact reviewed justification/i);
    return true;
  });
});
