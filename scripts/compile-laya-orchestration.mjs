import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLayaMapper, flattenAlertDocuments, rejectionReason, resolveAlertPointer } from "../src/laya-mapper.js";
import { LAYA_MAPPER_TARGETS } from "../src/laya-targets.js";
import { createPrepareBridge } from "./laya-prepare-bridge.mjs";

const NONE = "__none__";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [sourcePath, basePath, outputPath] = process.argv.slice(2).map((value) => value && path.resolve(value));
if (!sourcePath || !basePath || !outputPath) {
  throw new Error("Usage: compile-laya-orchestration <approved-source.jsonl> <base-model-directory> <trace.jsonl>");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const identity = (value) => JSON.stringify([value === null ? "null" : typeof value, value]);

function approvedRecord(value) {
  if (!value || value.schemaVersion !== 2 || value.synthetic !== true || typeof value.sampleId !== "string") throw new Error("Source record is not synthetic schemaVersion 2 data.");
  if (!Array.isArray(value.documents) || value.documents.length < 1 || value.documents.length > 16 || Buffer.byteLength(JSON.stringify(value.documents)) > 96 * 1024) throw new Error(`Source record ${value.sampleId} exceeds production document limits.`);
  const reviewer = value.review?.reviewer;
  if (value.review?.state !== "approved" || value.review?.blind !== true || !["pilotOnly", "releaseCandidate"].includes(value.review?.gate)
      || reviewer?.kind !== "independent-model" || typeof reviewer.model !== "string" || !reviewer.model
      || !/^[a-f0-9]{64}$/.test(reviewer.promptHash || "")
      || reviewer.model !== value.provenance?.blindReviewerModel || reviewer.promptHash !== value.provenance?.blindReviewPromptHash
      || !/^[a-f0-9]{64}$/.test(value.provenance?.reviewArtifactSha256 || "")
      || !/^[a-f0-9]{64}$/.test(value.provenance?.additionalDraftsSha256 || "")
      || !/^[a-f0-9]{64}$/.test(value.certificationHash || "")) throw new Error(`Source record ${value.sampleId} lacks bound independent-model review.`);
  if (!LAYA_MAPPER_TARGETS.every((target) => Object.hasOwn(value.decisions || {}, target)) || Object.keys(value.decisions).some((target) => !LAYA_MAPPER_TARGETS.includes(target))) throw new Error(`Source record ${value.sampleId} must label every production target exactly once.`);
  const leaves = flattenAlertDocuments(value.documents);
  const byPointer = new Map(leaves.map((field) => [field.pointer, field]));
  for (const [target, decision] of Object.entries(value.decisions)) {
    if (!["mapped", "absent", "unlabelled"].includes(decision?.state)) throw new Error(`Source record ${value.sampleId} has an invalid target decision.`);
    if (decision.state === "mapped") {
      if (!Array.isArray(decision.acceptedPointers) || !decision.acceptedPointers.includes(decision.primaryPointer) || !Object.hasOwn(decision, "resolvedValue")) throw new Error(`Source record ${value.sampleId}/${target} has incomplete mapped evidence.`);
      for (const pointer of decision.acceptedPointers) {
        const field = byPointer.get(pointer);
        if (!field || identity(field.value) !== identity(decision.resolvedValue) || resolveAlertPointer(value.documents, pointer) !== field.value) throw new Error(`Source record ${value.sampleId}/${target} does not resolve to its recorded typed value.`);
        if (rejectionReason(target, field.value)) throw new Error(`Source record ${value.sampleId}/${target} maps structurally ineligible evidence.`);
      }
    }
    for (const pointer of decision.hardNegativePointers || []) {
      const field = byPointer.get(pointer);
      if (!field || decision.acceptedPointers?.includes(pointer) || rejectionReason(target, field.value)) throw new Error(`Source record ${value.sampleId}/${target} has an invalid hard negative.`);
    }
  }
  return value;
}

async function traceRecord(record, bridge) {
  const tracesByTarget = new Map();
  const runner = {
    configure: async () => ({ effectiveWorkers: 1, threadsPerWorker: 1, capabilities: ["value-groups-v1"], ready: true }),
    close() {},
    async evaluate({ decisions }) {
      const prepared = await bridge.prepare(decisions);
      const preparedById = new Map(prepared.map((item) => [item.id, item]));
      const results = decisions.map((decision) => {
        const label = record.decisions[decision.target.id];
        const accepted = new Set(label.acceptedPointers || []);
        const hard = new Set(label.hardNegativePointers || []);
        const rendered = preparedById.get(decision.id)?.rendered;
        if (!rendered) throw new Error(`Renderer omitted ${decision.id}.`);
        let result;
        let gold;
        if (decision.kind === "classify") {
          const positive = accepted.has(decision.field.pointer);
          const items = rendered.items;
          const reviewed = label.positiveWindows?.[decision.field.pointer] || [];
          if (positive && items.length > 1 && !reviewed.length) throw new Error(`Long positive ${record.sampleId}/${decision.target.id}/${decision.field.pointer} requires reviewed token windows.`);
          const positiveWindows = items.length === 1 && positive ? [items[0].window] : reviewed;
          const positiveSet = new Set(positiveWindows.map((window) => `${window.startToken}:${window.endToken}`));
          const windows = items.map((item) => ({ ...item.window, score: positiveSet.has(`${item.window.startToken}:${item.window.endToken}`) ? 1 : 0, tokenAccounting: item.tokenAccounting }));
          const selectedWindow = windows.find((window) => window.score === 1) || windows[0];
          result = { id: decision.id, score: Math.max(...windows.map((window) => window.score)), evidence: items[0].evidence, selectedWindow, windows };
          gold = { positive, positiveWindows, hardNegative: hard.has(decision.field.pointer) };
        } else {
          const item = rendered.items[0];
          const consumed = item.consumed;
          const candidates = decision.candidates.slice(0, consumed);
          const preferred = candidates.find((candidate) => candidate.pointer === label.primaryPointer)
            || candidates.find((candidate) => accepted.has(candidate.pointer));
          const choice = preferred?.id || NONE;
          const optionIds = [...candidates.map((candidate) => candidate.id), NONE];
          result = { id: decision.id, consumed, choice, probabilities: Object.fromEntries(optionIds.map((id) => [id, Number(id === choice)])), tokenAccounting: item.tokenAccounting };
          gold = { choice, consumed };
        }
        if (!tracesByTarget.has(decision.target.id)) tracesByTarget.set(decision.target.id, []);
        tracesByTarget.get(decision.target.id).push({ sampleId: record.sampleId, target: decision.target.id, decision: structuredClone(decision), rendered, gold });
        return result;
      });
      return { results, runtime: { capabilities: ["value-groups-v1"] } };
    }
  };
  const targets = Object.entries(record.decisions).filter(([, decision]) => decision.state !== "unlabelled").map(([target]) => target);
  const result = await createLayaMapper({ runner }).mapIncident({ documents: record.documents, targets, experiment: "grouped", workerMode: "manual", workerCount: 1 });
  if (!result.processingComplete) throw new Error(`Production orchestration was incomplete for ${record.sampleId}: ${result.warning}`);
  for (const target of targets) {
    const coverage = result.coverage[target];
    if (coverage.scored !== coverage.eligible || coverage.finalAssessed !== coverage.eligible) throw new Error(`Candidate coverage is incomplete for ${record.sampleId}/${target}.`);
    const targetTraces = tracesByTarget.get(target) || [];
    const choices = targetTraces.filter((row) => row.decision.kind === "choose");
    const comparisons = result.provenance[target].comparisons;
    if (choices.length !== comparisons.length) throw new Error(`Comparison trace mismatch for ${record.sampleId}/${target}.`);
    choices.forEach((row, index) => { row.pass = comparisons[index].pass; });
    for (const row of targetTraces) {
      row.split = record.split;
      row.splitUnit = record.splitUnit;
      row.traceHash = digest(row);
    }
  }
  return [...tracesByTarget.values()].flat();
}

const records = (await readFile(sourcePath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => approvedRecord(JSON.parse(line)));
const bridge = createPrepareBridge({ compilerPath: path.join(root, "laya-mapper", "compiler.py"), basePath });
try {
  const traces = [];
  for (const record of records) traces.push(...await traceRecord(record, bridge));
  await writeFile(outputPath, traces.map((row) => canonical(row)).join("\n") + (traces.length ? "\n" : ""), "utf8");
} finally {
  bridge.close();
}
