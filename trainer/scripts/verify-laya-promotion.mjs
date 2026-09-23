import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYA_MAPPER_TARGETS, LAYA_PROMPT_VERSION } from "../../src/laya-targets.js";
import { canonical, caseTargetSetSha256, fileSha256, implementationSha256, sha256 } from "../../scripts/laya-evaluation-identity.mjs";

const args = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : "";
const required = ["--frozen-base", "--frozen-candidate", "--fixed-base", "--fixed-candidate", "--robustness-candidate",
  "--frozen-source", "--fixed-corpus", "--robustness-corpus", "--base-checkpoint-manifest", "--base-checkpoint-weights",
  "--candidate-checkpoint-manifest", "--candidate-checkpoint-weights", "--runtime-artifact"];
if (required.some((name) => !option(name))) throw new Error(`Usage requires ${required.join(", ")}.`);
async function load(name) {
  const file = path.resolve(option(name));
  const text = await readFile(file, "utf8");
  return { file, text, sha256: createHash("sha256").update(text).digest("hex"), value: JSON.parse(text) };
}
const frozenBase = await load("--frozen-base");
const frozenCandidate = await load("--frozen-candidate");
const fixedBase = await load("--fixed-base");
const fixedCandidate = await load("--fixed-candidate");
const robustness = await load("--robustness-candidate");
const expectedBaseCheckpoint = canonical({
  manifestSha256: await fileSha256(path.resolve(option("--base-checkpoint-manifest"))),
  weightsSha256: await fileSha256(path.resolve(option("--base-checkpoint-weights")))
});
const expectedCandidateCheckpoint = canonical({
  manifestSha256: await fileSha256(path.resolve(option("--candidate-checkpoint-manifest"))),
  weightsSha256: await fileSha256(path.resolve(option("--candidate-checkpoint-weights")))
});
const expectedRuntimeArtifactSha256 = await fileSha256(path.resolve(option("--runtime-artifact")));
const expectedFrozenSourceSha256 = await fileSha256(path.resolve(option("--frozen-source")));
const expectedFixedCorpusSha256 = await fileSha256(path.resolve(option("--fixed-corpus")));
const expectedRobustnessCorpusSha256 = await fileSha256(path.resolve(option("--robustness-corpus")));
const failures = [];
const HASH = /^[a-f0-9]{64}$/;
const metric = (report) => report.byExperiment?.grouped || report.metrics || {};
const flatTargets = (report) => (report.cases || []).flatMap((entry) => (entry.targets || []).map((target) => ({ caseId: entry.id, ...target })));
const fixedBaseMetric = metric(fixedBase.value);
const fixedCandidateMetric = metric(fixedCandidate.value);
const robustnessMetric = metric(robustness.value);

function comparableIdentity(report) {
  return canonical({ runtime: report.runtime, runtimeArtifactSha256: report.runtimeArtifactSha256 });
}
function checkpointIdentity(report) { return canonical(report.checkpoint); }
function fixedSet(report) {
  const byCase = new Map();
  for (const entry of report.cases || []) {
    const targets = (entry.targets || []).map((target) => target.target).sort();
    const previous = byCase.get(entry.id);
    if (previous && canonical(previous) !== canonical(targets)) failures.push(`Case target set changed within ${entry.id}.`);
    byCase.set(entry.id, targets);
  }
  return [...byCase].map(([id, targets]) => ({ id, targets }));
}
function frozenSet(report) {
  const byCase = new Map();
  for (const entry of report.cases || []) {
    const targets = (entry.outcomes || []).map((target) => target.target).sort();
    const previous = byCase.get(entry.sampleId);
    if (previous && canonical(previous) !== canonical(targets)) failures.push(`Frozen target set changed within ${entry.sampleId}.`);
    byCase.set(entry.sampleId, targets);
  }
  return [...byCase].map(([sampleId, targets]) => ({ sampleId, targets }));
}
async function validateFixedReport(report, label) {
  if (report.schemaVersion !== 3 || !HASH.test(report.corpusSha256 || "") || !HASH.test(report.sourceDocumentsSha256 || "") || !HASH.test(report.caseTargetSetSha256 || "")
      || !HASH.test(report.implementationSha256 || "") || !HASH.test(report.checkpoint?.manifestSha256 || "")
      || !HASH.test(report.checkpoint?.weightsSha256 || "") || !HASH.test(report.runtimeArtifactSha256 || "")
      || report.expectedRuns < 1 || report.selectedCaseCount < 1 || !Array.isArray(report.experiments) || !report.experiments.length
      || report.cases?.length !== report.expectedRuns * report.selectedCaseCount * report.experiments.length) failures.push(`${label} has incomplete immutable evaluation identity or run counts.`);
  if (caseTargetSetSha256(fixedSet(report)) !== report.caseTargetSetSha256) failures.push(`${label} case-target set hash is stale or mislabeled.`);
  const runKeys = new Set((report.cases || []).map((entry) => canonical([entry.id, entry.experiment, entry.run])));
  const expectedRunKeys = new Set(fixedSet(report).flatMap((entry) => report.experiments.flatMap((experiment) =>
    Array.from({ length: report.expectedRuns }, (_, index) => canonical([entry.id, experiment, index + 1])))));
  if (runKeys.size !== report.cases?.length || canonical([...runKeys].sort()) !== canonical([...expectedRunKeys].sort())
      || fixedSet(report).length !== report.selectedCaseCount) failures.push(`${label} has duplicated, missing, or mislabeled case runs.`);
  const rows = (report.cases || []).flatMap((entry) => entry.targets || []);
  const derived = {
    targets: rows.length, accepted: rows.filter((row) => row.accepted).length,
    falseAbsentMappings: rows.filter((row) => row.falseAbsentMapping).length,
    disagreements: rows.filter((row) => row.disagreement).length,
    incompleteRuns: (report.cases || []).filter((entry) => !entry.result?.processingComplete).length,
  };
  const reported = metric(report);
  if (Object.entries(derived).some(([key, value]) => reported[key] !== value)) failures.push(`${label} metrics do not match its exact cases.`);
  const corpusPath = path.resolve(root, report.corpus || "");
  try {
    const corpusBytes = await readFile(corpusPath);
    if (sha256(corpusBytes) !== report.corpusSha256) failures.push(`${label} corpus hash does not match the current exact corpus.`);
    const corpus = JSON.parse(corpusBytes);
    const selected = corpus.cases.filter((entry) => report.split === "all" || entry.split === report.split);
    const expectedCases = selected.map((entry) => ({ id: entry.id, targets: Object.keys(entry.expected) }));
    if (caseTargetSetSha256(expectedCases) !== report.caseTargetSetSha256) failures.push(`${label} case-target set does not match its bound corpus and split.`);
    const sourceHashes = await Promise.all(selected.map(async (entry) => ({
      id: entry.id,
      sha256: entry.documents ? sha256(canonical(entry.documents)) : sha256(await readFile(path.join(root, "test/fixtures", entry.fixture)))
    })));
    if (sha256(canonical(sourceHashes.sort((left, right) => left.id.localeCompare(right.id)))) !== report.sourceDocumentsSha256) failures.push(`${label} source-document hash does not match its exact fixture inputs.`);
  }
  catch { failures.push(`${label} corpus is unavailable for identity verification.`); }
}
async function validateFrozenReport(report, label) {
  if (report.schemaVersion !== 2 || report.metricScope !== "full-production-mapper" || report.split !== "frozen-test"
      || !HASH.test(report.sourceSha256 || "") || !HASH.test(report.caseTargetSetSha256 || "")
      || !HASH.test(report.implementationSha256 || "") || !HASH.test(report.checkpoint?.manifestSha256 || "")
      || !HASH.test(report.checkpoint?.weightsSha256 || "") || !HASH.test(report.runtimeArtifactSha256 || "")
      || report.expectedRuns < 2 || report.cases?.length !== report.records * report.expectedRuns) failures.push(`${label} has incomplete immutable frozen identity or run counts.`);
  if (caseTargetSetSha256(frozenSet(report)) !== report.caseTargetSetSha256) failures.push(`${label} case-target set hash is stale or mislabeled.`);
  const expectedTargets = [...LAYA_MAPPER_TARGETS].sort();
  if (frozenSet(report).some((entry) => canonical(entry.targets) !== canonical(expectedTargets))) failures.push(`${label} does not cover the exact 23-target production catalogue.`);
  const runKeys = new Set((report.cases || []).map((entry) => canonical([entry.sampleId, entry.run])));
  const expectedRunKeys = new Set(frozenSet(report).flatMap((entry) => Array.from({ length: report.expectedRuns }, (_, index) => canonical([entry.sampleId, index + 1]))));
  if (runKeys.size !== report.cases?.length || canonical([...runKeys].sort()) !== canonical([...expectedRunKeys].sort())
      || frozenSet(report).length !== report.records) failures.push(`${label} has duplicated, missing, or mislabeled frozen runs.`);
  const rows = (report.cases || []).flatMap((entry) => entry.outcomes || []).filter((row) => row.scored);
  const coverageFailures = (report.cases || []).reduce((total, entry) => total
    + (entry.outcomes?.length === LAYA_MAPPER_TARGETS.length && Object.keys(entry.coverage || {}).length === LAYA_MAPPER_TARGETS.length ? 0 : 1)
    + Object.values(entry.coverage || {}).filter((coverage) => coverage.scored !== coverage.eligible || coverage.finalAssessed !== coverage.eligible).length, 0);
  const derived = {
    targets: rows.length, accepted: rows.filter((row) => row.accepted).length,
    falseAbsentMappings: rows.filter((row) => row.falseAbsentMapping).length,
    incompleteRuns: (report.cases || []).filter((entry) => !entry.processingComplete).length, coverageFailures,
  };
  if (Object.entries(derived).some(([key, value]) => report.metrics?.[key] !== value)) failures.push(`${label} metrics do not match its exact cases.`);
  try {
    const sourceBytes = await readFile(path.resolve(report.source || ""));
    if (sha256(sourceBytes) !== report.sourceSha256) failures.push(`${label} source hash does not match the exact reviewed source.`);
    const expectedCases = sourceBytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      .filter((row) => row.split === "frozen-test").map((row) => ({ sampleId: row.sampleId, targets: LAYA_MAPPER_TARGETS }));
    if (caseTargetSetSha256(expectedCases) !== report.caseTargetSetSha256) failures.push(`${label} case-target set does not match its exact reviewed frozen source.`);
  }
  catch { failures.push(`${label} reviewed source is unavailable for identity verification.`); }
}

await Promise.all([
  validateFrozenReport(frozenBase.value, "Frozen base"), validateFrozenReport(frozenCandidate.value, "Frozen candidate"),
  validateFixedReport(fixedBase.value, "Fixed base"), validateFixedReport(fixedCandidate.value, "Fixed candidate"),
  validateFixedReport(robustness.value, "Robustness candidate")
]);
const expectedFixedImplementation = await implementationSha256(root, "scripts/evaluate-laya-mapper.mjs");
const expectedFrozenImplementation = await implementationSha256(root, "trainer/scripts/evaluate-laya-reviewed-sources.mjs");
if ([fixedBase.value, fixedCandidate.value, robustness.value].some((report) => report.implementationSha256 !== expectedFixedImplementation)
    || [frozenBase.value, frozenCandidate.value].some((report) => report.implementationSha256 !== expectedFrozenImplementation)) failures.push("An evaluation report was produced by stale evaluator or mapper code.");
if (comparableIdentity(fixedBase.value) !== comparableIdentity(fixedCandidate.value)
    || comparableIdentity(fixedCandidate.value) !== comparableIdentity(robustness.value)
    || comparableIdentity(frozenBase.value) !== comparableIdentity(frozenCandidate.value)) failures.push("Comparable base/candidate reports do not share the exact runtime, prompt, worker, and thread identity.");
if (checkpointIdentity(fixedBase.value) !== checkpointIdentity(frozenBase.value)
    || checkpointIdentity(fixedCandidate.value) !== checkpointIdentity(robustness.value)
    || checkpointIdentity(fixedCandidate.value) !== checkpointIdentity(frozenCandidate.value)) failures.push("Checkpoint identity is inconsistent across evaluation reports.");
if (checkpointIdentity(fixedBase.value) !== expectedBaseCheckpoint || checkpointIdentity(frozenBase.value) !== expectedBaseCheckpoint
    || checkpointIdentity(fixedCandidate.value) !== expectedCandidateCheckpoint || checkpointIdentity(robustness.value) !== expectedCandidateCheckpoint
    || checkpointIdentity(frozenCandidate.value) !== expectedCandidateCheckpoint) failures.push("A report does not bind the exact checkpoint artifacts supplied for promotion.");
if ([fixedBase.value, fixedCandidate.value, robustness.value, frozenBase.value, frozenCandidate.value]
  .some((report) => report.runtimeArtifactSha256 !== expectedRuntimeArtifactSha256)) failures.push("A report does not bind the exact runtime artifact supplied for promotion.");
if (canonical({ corpus: fixedBase.value.corpusSha256, sources: fixedBase.value.sourceDocumentsSha256, targets: fixedBase.value.caseTargetSetSha256, runs: fixedBase.value.expectedRuns, split: fixedBase.value.split, experiments: fixedBase.value.experiments })
    !== canonical({ corpus: fixedCandidate.value.corpusSha256, sources: fixedCandidate.value.sourceDocumentsSha256, targets: fixedCandidate.value.caseTargetSetSha256, runs: fixedCandidate.value.expectedRuns, split: fixedCandidate.value.split, experiments: fixedCandidate.value.experiments })) failures.push("Fixed base and candidate reports are not directly comparable.");
if (fixedBase.value.corpusSha256 !== expectedFixedCorpusSha256 || fixedCandidate.value.corpusSha256 !== expectedFixedCorpusSha256
    || robustness.value.corpusSha256 !== expectedRobustnessCorpusSha256
    || frozenBase.value.sourceSha256 !== expectedFrozenSourceSha256 || frozenCandidate.value.sourceSha256 !== expectedFrozenSourceSha256) failures.push("A report is not bound to the exact source or corpus supplied for promotion.");
if (frozenBase.value.expectedRuns !== frozenCandidate.value.expectedRuns || frozenBase.value.caseTargetSetSha256 !== frozenCandidate.value.caseTargetSetSha256) failures.push("Frozen base and candidate run/target sets differ.");
for (const report of [fixedBase.value, fixedCandidate.value, robustness.value, frozenBase.value, frozenCandidate.value]) {
  if (report.runtime?.promptVersion !== LAYA_PROMPT_VERSION || report.runtime?.protocolVersion !== 2
      || !Number.isInteger(report.runtime?.effectiveWorkers) || !Number.isInteger(report.runtime?.threadsPerWorker)) failures.push("Evaluation runtime identity has an invalid prompt, protocol, worker, or thread contract.");
}

for (const report of [frozenBase.value, frozenCandidate.value]) {
  if (report.metricScope !== "full-production-mapper" || report.split !== "frozen-test") failures.push("Frozen inputs must be full production-mapper frozen-test reports.");
}
if (frozenBase.value.sourceSha256 !== frozenCandidate.value.sourceSha256 || frozenBase.value.records !== frozenCandidate.value.records || frozenBase.value.families !== frozenCandidate.value.families) failures.push("Base and candidate did not evaluate identical untouched frozen source families.");
if (frozenCandidate.value.productionTargets !== 23 || frozenCandidate.value.records < 1 || frozenCandidate.value.families < 1
    || frozenCandidate.value.metrics.incompleteRuns !== 0 || frozenCandidate.value.metrics.coverageFailures !== 0) failures.push("Candidate has incomplete 23-target frozen production coverage.");
if (!frozenCandidate.value.savedReloadPredictionEquality || frozenCandidate.value.modelReloadPasses < 2) failures.push("Candidate lacks repeated saved/reloaded production-output equality.");
if (frozenCandidate.value.metrics.accepted < frozenBase.value.metrics.accepted) failures.push("Candidate regresses frozen pointer/none outcomes.");
if (frozenCandidate.value.metrics.falseAbsentMappings > frozenBase.value.metrics.falseAbsentMappings) failures.push("Candidate increases frozen false-absent mappings.");

if (fixedCandidateMetric.targets !== 47 || fixedCandidateMetric.accepted < 24) failures.push("Fixed corpus must retain at least 24/47 accepted mappings.");
if (fixedCandidateMetric.falseAbsentMappings > 3) failures.push("Fixed-corpus false-absent mappings exceed 3/47.");
if (fixedBaseMetric.falseAbsentMappings > 0 && fixedCandidateMetric.falseAbsentMappings >= fixedBaseMetric.falseAbsentMappings) failures.push("Fixed-corpus false-absent mappings were not materially reduced.");
if (fixedCandidateMetric.incompleteRuns !== 0) failures.push("Fixed corpus contains incomplete runs.");
if (robustnessMetric.targets !== 19 || robustnessMetric.accepted < 8 || robustnessMetric.incompleteRuns !== 0) failures.push("Robustness gate requires at least 8/19 accepted with no incomplete runs.");

const baseRows = new Map(flatTargets(fixedBase.value).map((row) => [JSON.stringify([row.caseId, row.target]), row]));
const candidateRows = flatTargets(fixedCandidate.value);
if (candidateRows.some((row) => row.wrong && !baseRows.get(JSON.stringify([row.caseId, row.target]))?.wrong)) failures.push("Candidate introduces a new wrong fixed-corpus mapping.");
if (candidateRows.some((row) => row.expected && row.accepted && row.correctFieldAssessed === false)) failures.push("A correct fixed-corpus field was not final-assessed.");
if (fixedCandidateMetric.disagreements > fixedBaseMetric.disagreements && fixedCandidateMetric.accepted <= fixedBaseMetric.accepted) failures.push("Forward/reverse disagreement worsened without an accuracy gain.");

const entraRows = candidateRows.filter((row) => /entra/i.test(row.caseId));
if (entraRows.length !== 5 || entraRows.some((row) => !row.accepted)) failures.push("Entra regression must remain 5/5 accepted.");
const entraCustomer = entraRows.find((row) => row.target === "customerName");
if (!entraCustomer || entraCustomer.actual !== null || !entraCustomer.accepted) failures.push("Entra customerName must remain a correct no-match.");

function warmPerformance(report) {
  const warm = (report.cases || []).filter((entry) => entry.runtimeState === "warm");
  return {
    meanMs: warm.reduce((sum, entry) => sum + (entry.result?.timings?.totalMs || 0), 0) / Math.max(1, warm.length),
    peakBytes: Math.max(0, ...warm.map((entry) => entry.result?.runtime?.peakWorkingSetBytes || 0))
  };
}
const basePerf = warmPerformance(fixedBase.value);
const candidatePerf = warmPerformance(fixedCandidate.value);
if (basePerf.meanMs <= 0 || candidatePerf.meanMs <= 0 || basePerf.peakBytes <= 0 || candidatePerf.peakBytes <= 0) failures.push("CPU warm runtime and peak RAM measurements are required.");
let resourceJustification;
if (option("--resource-justification")) {
  const justification = await load("--resource-justification");
  const value = justification.value;
  if (value.schemaVersion !== 1 || value.review?.state !== "approved" || value.review?.kind !== "independent-model"
      || typeof value.review?.model !== "string" || !value.review.model || typeof value.review?.version !== "string" || !value.review.version
      || !HASH.test(value.review?.promptHash || "") || !Array.isArray(value.allow)
      || !value.allow.every((item) => ["warmTime", "peakRam"].includes(item)) || !value.allow.length || new Set(value.allow).size !== value.allow.length
      || typeof value.rationale !== "string" || !value.rationale.trim()
      || value.bindings?.fixedBaseSha256 !== fixedBase.sha256 || value.bindings?.fixedCandidateSha256 !== fixedCandidate.sha256) {
    failures.push("Resource-regression justification is not explicitly reviewed and bound to these exact reports.");
  } else resourceJustification = { sha256: justification.sha256, allow: value.allow, reviewer: value.review };
}
if (basePerf.meanMs > 0 && candidatePerf.meanMs > basePerf.meanMs * 1.15 && !resourceJustification?.allow.includes("warmTime")) failures.push("CPU warm runtime regresses by more than 15% without an exact reviewed justification.");
if (basePerf.peakBytes > 0 && candidatePerf.peakBytes > basePerf.peakBytes * 1.15 && !resourceJustification?.allow.includes("peakRam")) failures.push("Peak RAM regresses by more than 15% without an exact reviewed justification.");

const result = {
  schemaVersion: 2,
  eligible: failures.length === 0,
  failures: [...new Set(failures)],
  artifacts: Object.fromEntries([frozenBase, frozenCandidate, fixedBase, fixedCandidate, robustness].map((entry) => [entry.file, entry.sha256])),
  gates: {
    frozenBase: frozenBase.value.metrics, frozenCandidate: frozenCandidate.value.metrics,
    fixedBase: fixedBaseMetric, fixedCandidate: fixedCandidateMetric, robustness: robustnessMetric,
    warmPerformance: { base: basePerf, candidate: candidatePerf, resourceJustification: resourceJustification || null }
  },
  fallback: failures.length ? "ship-pinned-base-assets" : "candidate-may-enter-manual-promotion-review"
};
const outputPath = path.resolve(option("--output") || "artifacts/laya-training/promotion-gate.json");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
if (!result.eligible) process.exitCode = 1;
