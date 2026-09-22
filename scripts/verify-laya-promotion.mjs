import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : "";
const required = ["--frozen-base", "--frozen-candidate", "--fixed-base", "--fixed-candidate", "--robustness-candidate"];
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
const failures = [];
const metric = (report) => report.byExperiment?.grouped || report.metrics;
const flatTargets = (report) => (report.cases || []).flatMap((entry) => (entry.targets || []).map((target) => ({ caseId: entry.id, ...target })));
const fixedBaseMetric = metric(fixedBase.value);
const fixedCandidateMetric = metric(fixedCandidate.value);
const robustnessMetric = metric(robustness.value);

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
const accuracyGain = fixedCandidateMetric.accepted > fixedBaseMetric.accepted;
if (basePerf.meanMs <= 0 || candidatePerf.meanMs <= 0 || basePerf.peakBytes <= 0 || candidatePerf.peakBytes <= 0) failures.push("CPU warm runtime and peak RAM measurements are required.");
if (!accuracyGain && basePerf.meanMs > 0 && candidatePerf.meanMs > basePerf.meanMs * 1.15) failures.push("CPU warm runtime regresses by more than 15% without an accuracy gain.");
if (!accuracyGain && basePerf.peakBytes > 0 && candidatePerf.peakBytes > basePerf.peakBytes * 1.15) failures.push("Peak RAM regresses by more than 15% without an accuracy gain.");

const result = {
  schemaVersion: 2,
  eligible: failures.length === 0,
  failures: [...new Set(failures)],
  artifacts: Object.fromEntries([frozenBase, frozenCandidate, fixedBase, fixedCandidate, robustness].map((entry) => [entry.file, entry.sha256])),
  gates: {
    frozenBase: frozenBase.value.metrics, frozenCandidate: frozenCandidate.value.metrics,
    fixedBase: fixedBaseMetric, fixedCandidate: fixedCandidateMetric, robustness: robustnessMetric,
    warmPerformance: { base: basePerf, candidate: candidatePerf }
  },
  fallback: failures.length ? "ship-pinned-base-assets" : "candidate-may-enter-manual-promotion-review"
};
const outputPath = path.resolve(option("--output") || "artifacts/laya-training/promotion-gate.json");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
if (!result.eligible) process.exitCode = 1;
