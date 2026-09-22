import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createLayaMapper, resolveAlertPointer } from "../src/laya-mapper.js";
import { LAYA_EXPERIMENTS, DEFAULT_LAYA_EXPERIMENT } from "../src/laya-targets.js";
import { createLayaWorkerPool, createLayaSidecarRunner } from "../src/laya-worker.js";
import { assertStableRuntimeIdentity, canonical, caseTargetSetSha256, fileSha256, implementationSha256, runtimeContract, sha256 } from "./laya-evaluation-identity.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const split = option("--split", "development");
const workers = Number(option("--workers", "1"));
const runs = Number(option("--runs", "1"));
const experiments = option("--variants", DEFAULT_LAYA_EXPERIMENT).split(",");
const checkpointManifestOption = option("--checkpoint-manifest");
const checkpointWeightsOption = option("--checkpoint-weights");
const runtimeArtifactOption = option("--runtime-artifact");
const modelOption = option("--model");
if (!experiments.length || new Set(experiments).size !== experiments.length || experiments.some((name) => !Object.hasOwn(LAYA_EXPERIMENTS, name))) throw new Error("Invalid experiment selection.");
if (!["development", "evaluation", "all"].includes(split) || ![1, 2, 3, 4].includes(workers) || !Number.isInteger(runs) || runs < 1
    || !checkpointManifestOption || !checkpointWeightsOption || !runtimeArtifactOption || !modelOption) throw new Error("Evaluation requires valid split/runs plus --model, --checkpoint-manifest, --checkpoint-weights and --runtime-artifact identity inputs.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = path.resolve(option("--corpus", path.join(root, "test/fixtures/laya-baseline-cases.json")));
const corpusText = await readFile(corpusPath, "utf8");
const corpus = JSON.parse(corpusText);
const output = path.resolve(option("--output", "artifacts/laya-improvements/evaluation.json"));
await mkdir(path.dirname(output), { recursive: true });
// --python is a development convenience only; the default always uses the packaged executable.
const python = option("--python");
const modelPath = path.resolve(modelOption);
const checkpointWeightsPath = path.resolve(checkpointWeightsOption);
const runtimeExecutablePath = path.resolve(python || runtimeArtifactOption);
if (python && runtimeExecutablePath !== path.resolve(runtimeArtifactOption)) throw new Error("Runtime artifact identity must name the executable actually used.");
if (checkpointWeightsPath !== path.join(modelPath, "model.safetensors")) throw new Error("Checkpoint weights identity must name the model directory's model.safetensors.");
const mapper = createLayaMapper({ runner: createLayaWorkerPool({ runnerFactory: (settings) => createLayaSidecarRunner({
  ...settings,
  executable: runtimeExecutablePath,
  ...(python ? { arguments_: [path.join(root, "laya-mapper/runner.py"), "serve"] } : {}),
  env: { LAYA_MODEL_PATH: modelPath }
}) }) });
const selectedCases = corpus.cases.filter((item) => (split === "all" || item.split === split) && (!option("--case") || item.id === option("--case")));
if (!selectedCases.length) throw new Error("No evaluation cases matched.");
const loadedInputs = await Promise.all(selectedCases.map(async (entry) => {
  if (entry.documents) return { id: entry.id, documents: entry.documents, sha256: sha256(canonical(entry.documents)) };
  const bytes = await readFile(path.join(root, "test/fixtures", entry.fixture));
  return { id: entry.id, documents: [JSON.parse(bytes.toString("utf8"))], sha256: sha256(bytes) };
}));
const selectedInputs = new Map(loadedInputs.map((entry) => [entry.id, entry.documents]));
if (selectedInputs.size !== selectedCases.length) throw new Error("Evaluation corpus contains duplicate selected case IDs.");
const report = {
  schemaVersion: 3, createdAt: new Date().toISOString(), corpus: path.relative(root, corpusPath), split, workers, experiments,
  corpusSha256: sha256(corpusText), expectedRuns: runs, selectedCaseCount: selectedCases.length,
  sourceDocumentsSha256: sha256(canonical(loadedInputs.map(({ id, sha256 }) => ({ id, sha256 })).sort((left, right) => left.id.localeCompare(right.id)))),
  caseTargetSetSha256: caseTargetSetSha256(selectedCases.map((entry) => ({ id: entry.id, targets: Object.keys(entry.expected) }))),
  implementationSha256: await implementationSha256(root, "scripts/evaluate-laya-mapper.mjs"),
  checkpoint: { manifestSha256: await fileSha256(path.resolve(checkpointManifestOption)), weightsSha256: await fileSha256(checkpointWeightsPath) },
  runtimeArtifactSha256: await fileSha256(runtimeExecutablePath),
  host: { processors: os.availableParallelism(), totalMemory: os.totalmem(), cpu: os.cpus()[0]?.model }, cases: []
};
try {
 for (const experiment of experiments) {
  mapper.close();
  let firstRun = true;
  for (const entry of selectedCases) {
    const documents = selectedInputs.get(entry.id);
    for (let run = 0; run < runs; run++) {
      const result = await mapper.mapIncident({ documents, targets: Object.keys(entry.expected), workerMode: "manual", workerCount: workers, experiment, onProgress: ({ detail }) => { if (args.includes("--progress")) console.error(detail); } });
      const identity = runtimeContract(result.runtime);
      if (!report.runtime) report.runtime = identity;
      else assertStableRuntimeIdentity(report.runtime, result.runtime);
      const targets = Object.entries(entry.expected).map(([target, expected]) => {
        const actual = result.paths[target] || null;
        const trace = result.provenance[target];
        const correct = expected ? [expected.preferred, ...(expected.accepted || [])] : [];
        const preferredCandidate = trace.candidates.find((candidate) => candidate.pointer === expected?.preferred);
        const noMatch = actual === null && result.statuses[target] === "no_supported_match";
        const valueCorrect = expected ? actual !== null && correct.some((pointer) => JSON.stringify(resolveAlertPointer(documents, pointer)) === JSON.stringify(result.fields[target])) : noMatch;
        return { target, expected, actual, status: result.statuses[target], exact: expected ? actual === expected.preferred : noMatch, accepted: expected ? correct.includes(actual) : noMatch, valueCorrect, valueAgreement: trace.agreement.value, pointerAgreement: trace.agreement.pointer, wrong: actual !== null && !correct.includes(actual), missed: expected !== null && actual === null, falseAbsentMapping: expected === null && actual !== null, stageOneRank: preferredCandidate ? trace.candidates.indexOf(preferredCandidate) + 1 : null, correctFieldAssessed: preferredCandidate ? trace.assessedIds.includes(preferredCandidate.id) : expected === null ? null : false, disagreement: trace.disagreements };
      });
      report.cases.push({ id: entry.id, family: entry.family, split: entry.split, experiment, run: run + 1, runtimeState: firstRun ? "cold" : "warm", targets, result });
      firstRun = false;
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify({ experiment, case: entry.id, run: run + 1, complete: result.processingComplete, ms: result.timings.totalMs, mappings: targets.map(({ target, actual, status, accepted, valueCorrect }) => ({ target, actual, status, accepted, valueCorrect })) }));
    }
  }
 }
} finally { mapper.close(); }
function metrics(cases) {
const rows = cases.flatMap((entry) => entry.targets);
const count = (predicate) => rows.filter(predicate).length;
return { targets: rows.length, exact: count((r) => r.exact), accepted: count((r) => r.accepted), valuesCorrect: count((r) => r.valueCorrect), wrong: count((r) => r.wrong), missed: count((r) => r.missed), falseAbsentMappings: count((r) => r.falseAbsentMapping), tentative: count((r) => r.status === "tentative"), tentativeAccepted: count((r) => r.status === "tentative" && r.accepted), disagreements: count((r) => r.disagreement), valueDisagreements: count((r) => r.valueAgreement === "disagreed"), incompleteRuns: cases.filter((r) => !r.result.processingComplete).length, elapsedMs: cases.reduce((n, c) => n + c.result.timings.totalMs, 0), eligible: cases.reduce((n, c) => n + Object.values(c.result.coverage).reduce((m, v) => m + v.eligible, 0), 0), finalAssessed: cases.reduce((n, c) => n + Object.values(c.result.coverage).reduce((m, v) => m + v.finalAssessed, 0), 0) };
}
report.metrics = metrics(report.cases);
report.byExperiment = Object.fromEntries(experiments.map((name) => [name, metrics(report.cases.filter((c) => c.experiment === name))]));
if (report.cases.length !== selectedCases.length * runs * experiments.length) throw new Error("Evaluation report has an unexpected case/run count.");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, byExperiment: report.byExperiment }));
