import { createHash } from "node:crypto";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { LAYA_TARGET_CATALOGUE, LAYA_MAPPER_TARGETS, LAYA_MODEL, LAYA_CHECKPOINT_ID, LAYA_EXPERIMENTS, DEFAULT_LAYA_EXPERIMENT } from "./laya-targets.js";
import { createLayaWorkerPool } from "./laya-worker.js";
export { LAYA_MAPPER_TARGETS, HISTORIC_LAYA_TARGETS } from "./laya-targets.js";
export { createLayaSidecarRunner } from "./laya-worker.js";

export const DEFAULT_LAYA_CHECKPOINT = LAYA_CHECKPOINT_ID;
export const layaMapperSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  checkpointId: z.string().regex(/^[A-Za-z0-9._-]+$/).max(128).default(DEFAULT_LAYA_CHECKPOINT),
  workerMode: z.enum(["auto", "manual"]).default("auto"),
  workerCount: z.number().int().min(1).max(4).default(1)
}).strict();
const NONE = "__none__";
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pointerPart = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
const scalarText = (value) => value == null ? "" : String(value).trim();
const valueIdentity = (field) => JSON.stringify([field.type, field.value]);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})?$/;
function cancelled(signal) { if (signal?.aborted) throw new Error("Laya-mapper operation was cancelled."); }

function isoTimestampMs(text) {
  const match = ISO_TIMESTAMP.exec(text);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const structural = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (structural.getUTCFullYear() !== parts[0] || structural.getUTCMonth() !== parts[1] - 1
      || structural.getUTCDate() !== parts[2] || structural.getUTCHours() !== parts[3]
      || structural.getUTCMinutes() !== parts[4] || structural.getUTCSeconds() !== parts[5]) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`);
}

function unixTimestampMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  const magnitude = Math.abs(numeric);
  if (magnitude >= 1e17) return numeric / 1e6; // nanoseconds
  if (magnitude >= 1e14) return numeric / 1e3; // microseconds
  if (magnitude >= 1e11) return numeric; // milliseconds
  return numeric * 1000; // seconds
}

export function flattenAlertDocuments(documents) {
  if (!Array.isArray(documents)) throw new Error("Laya-mapper requires an array of alert JSON documents.");
  if (Buffer.byteLength(JSON.stringify(documents)) > 96 * 1024) throw new Error("The detailed alert JSON exceeds the Laya-mapper processing limit.");
  const leaves = [];
  let visited = 0;
  const visit = (value, parts, depth) => {
    if (depth > 30 || ++visited > 10000) throw new Error("The detailed alert JSON is too complex for Laya-mapper.");
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, [...parts, String(index)], depth + 1));
    if (value !== null && typeof value === "object") return Object.keys(value).sort(compare).forEach((key) => visit(value[key], [...parts, key], depth + 1));
    if (value !== null && (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value)))) throw new Error("Unsupported JSON scalar.");
    const pointer = "/" + parts.map(pointerPart).join("/");
    leaves.push({ id: "f" + createHash("sha256").update(pointer).digest("hex").slice(0, 20), pointer, ancestry: parts.slice(0, -1), key: parts.at(-1) || "", type: value === null ? "null" : typeof value, value });
  };
  documents.forEach((document, index) => visit(document, ["documents", String(index)], 0));
  return leaves;
}

export function resolveAlertPointer(documents, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/documents/")) return undefined;
  let value = { documents };
  for (const part of pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

export function rejectionReason(target, value) {
  const text = scalarText(value);
  if (!text) return "empty_value";
  const type = LAYA_TARGET_CATALOGUE[target].valueType;
  if (type === "identifier" && typeof value === "number") return "";
  if (type === "ip") return net.isIP(text) ? "" : "invalid_ip";
  if (type === "url") { try { return ["https:", "http:"].includes(new URL(text).protocol) ? "" : "invalid_url"; } catch { return "invalid_url"; } }
  if (type === "timestamp") {
    const numeric = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(text) ? Number(value) : NaN;
    const ms = Number.isFinite(numeric) ? unixTimestampMs(numeric) : isoTimestampMs(text);
    return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1) ? "" : "invalid_event_time";
  }
  return typeof value === "string" ? "" : type === "identifier" ? "requires_text_or_number" : "requires_text";
}

function contextualize(leaves) {
  const groups = new Map();
  for (const leaf of leaves) {
    const key = JSON.stringify(leaf.ancestry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(leaf);
  }
  return leaves.map((leaf) => {
    const siblings = groups.get(JSON.stringify(leaf.ancestry)).filter((other) => other.id !== leaf.id);
    if (leaf.key === "value") siblings.sort((a, b) => Number(b.key === "key") - Number(a.key === "key") || compare(a.key, b.key));
    return { ...leaf, context: siblings.slice(0, 8).map(({ key, value }) => ({ key, value: typeof value === "string" ? value.slice(0, 256) : value })), omittedSiblings: Math.max(0, siblings.length - 8), shortenedSiblings: siblings.slice(0, 8).filter(({ value }) => typeof value === "string" && value.length > 256).length };
  });
}

function validateResults(decisions, response) {
  if (!Array.isArray(response?.results) || response.results.length !== decisions.length) throw new Error("Laya returned incomplete decision coverage.");
  const byId = new Map();
  for (const item of response.results) {
    if (byId.has(item.id)) throw new Error("Laya returned a duplicate decision.");
    byId.set(item.id, item);
  }
  return decisions.map((decision) => {
    const item = byId.get(decision.id);
    if (!item || item.error) throw new Error(item?.error || "Laya omitted a decision.");
    if (decision.kind === "classify" && (!Number.isFinite(item.score) || item.score < 0 || item.score > 1 || !Array.isArray(item.windows) || !item.windows.length || typeof item.evidence !== "string")) throw new Error("Laya returned an invalid field score.");
    if (decision.kind === "classify") {
      const windows = item.windows;
      if (windows.some((w, index) => !Number.isInteger(w.startToken) || !Number.isInteger(w.endToken) || !Number.isInteger(w.totalValueTokens)
        || w.startToken < 0 || w.endToken < w.startToken || w.endToken > w.totalValueTokens || !Number.isFinite(w.score) || w.score < 0 || w.score > 1
        || (index && (w.startToken <= windows[index - 1].startToken || w.startToken >= windows[index - 1].endToken || w.totalValueTokens !== windows[0].totalValueTokens)))
        || windows[0].startToken !== 0 || windows.at(-1).endToken !== windows[0].totalValueTokens
        || Math.abs(item.score - Math.max(...windows.map((w) => w.score))) > 1e-6
        || !windows.some((w) => w.startToken === item.selectedWindow?.startToken && w.endToken === item.selectedWindow?.endToken && w.score === item.score)) throw new Error("Laya returned incomplete or invalid window coverage.");
    }
    if (decision.kind === "choose") {
      const n = item.consumed;
      if (!Number.isInteger(n) || n < 1 || n > decision.candidates.length || (decision.candidates.length > 1 && n < 2)) throw new Error("Laya comparison did not make progress.");
      const ids = [...decision.candidates.slice(0, n).map((candidate) => candidate.id), NONE];
      if (!ids.includes(item.choice) || !item.probabilities || Object.keys(item.probabilities).length !== ids.length
        || ids.some((id) => !Number.isFinite(item.probabilities[id]) || item.probabilities[id] < 0 || item.probabilities[id] > 1)
        || Math.abs(Object.values(item.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.002) throw new Error("Laya returned an invalid choice distribution.");
      if (item.probabilities[item.choice] < Math.max(...Object.values(item.probabilities))) throw new Error("Laya choice disagrees with its probabilities.");
    }
    return item;
  });
}

async function parallelJobs(items, count, action) {
  let next = 0, stopped = false;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const item = items[next++];
      try { await action(item); } catch (error) { stopped = true; throw error; }
    }
  }));
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

export function createLayaMapper({ runner = createLayaWorkerPool() } = {}) {
  return {
    status: () => runner.status(),
    close: () => runner.close?.(),
    async mapIncident({ documents, targets = LAYA_MAPPER_TARGETS, complete = true, workerMode = "auto", workerCount = 1, experiment = DEFAULT_LAYA_EXPERIMENT, onProgress, signal }) {
      const started = performance.now();
      const progress = (detail, stage = "working", completed = 0, total = 0, extra = {}) => {
        try { onProgress?.({ detail, stage, completed, total, ...extra }); } catch {}
      };
      if (!Array.isArray(targets) || targets.some((target) => !LAYA_MAPPER_TARGETS.includes(target))) throw new Error("Unsupported Laya target.");
      if (!Object.hasOwn(LAYA_EXPERIMENTS, experiment)) throw new Error("Unsupported Laya experiment.");
      const options = LAYA_EXPERIMENTS[experiment];
      targets = [...new Set(targets)];
      cancelled(signal);
      const leaves = contextualize(flattenAlertDocuments(documents));
      const fields = {}, paths = {}, provenance = {}, statuses = {}, timings = {};
      let decisionsCompleted = 0, requestId = 0;
      const candidatesByTarget = new Map();
      for (const target of targets) {
        const candidates = [], rejected = [];
        for (const leaf of leaves) {
          const reason = rejectionReason(target, leaf.value);
          if (reason) rejected.push({ id: leaf.id, pointer: leaf.pointer, reason });
          else candidates.push(leaf);
        }
        candidatesByTarget.set(target, candidates);
        provenance[target] = { rejected, candidates: [], comparisons: [], assessedIds: [], selectedPointer: "", nominees: [], disagreements: false, groups: [], agreement: { value: "none", pointer: "none" } };
        statuses[target] = "incomplete";
      }
      let runtime, failure = "";
      const evaluate = async (decisions) => {
        cancelled(signal);
        const response = await runner.evaluate({ decisions }, { signal });
        cancelled(signal);
        const results = validateResults(decisions, response);
        if (response.runtime) runtime = { ...runtime, ...response.runtime };
        decisionsCompleted += results.length;
        return results;
      };
      const abort = () => runner.close?.();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const classifyStarted = performance.now();
        const jobs = targets.flatMap((target) => candidatesByTarget.get(target).map((field) => ({ id: "d" + requestId++, kind: "classify", field, target: { id: target, ...LAYA_TARGET_CATALOGUE[target] } })));
        const batches = [];
        for (let index = 0; index < jobs.length; index += 16) batches.push(jobs.slice(index, index + 16));
        progress("Loading the reviewed Laya demo checkpoint; examining " + leaves.length + " fields for " + targets.length + " targets.", "loading", 0, 1);
        if (jobs.length) runtime = await runner.configure?.({ workerMode, workerCount, workItems: batches.length });
        else runtime = { effectiveWorkers: 0, threadsPerWorker: 0, workerMode, requestedWorkers: workerCount, ready: false, detail: "No structurally eligible pairs require model inference." };
        if (jobs.length && experiment !== "baseline" && !runtime?.capabilities?.includes("value-groups-v1")) throw new Error("Update the Laya inference runtime for exact typed-value grouping.");
        if (runtime) progress("Using " + runtime.effectiveWorkers + " CPU worker(s), " + runtime.threadsPerWorker + " threads each. Starting field assessment.", "field_assessment", 0, jobs.length);
        let assessed = 0;
        await parallelJobs(batches, runtime?.effectiveWorkers || 1, async (batch) => {
          const results = await evaluate(batch);
          results.forEach((item, index) => {
            const { target, field } = batch[index];
            provenance[target.id].candidates.push({ id: field.id, pointer: field.pointer, score: item.score, windows: item.windows, selectedWindow: item.selectedWindow, evidence: item.evidence, tokenAccounting: item.tokenAccounting });
          });
          assessed += batch.length;
          progress("Field assessment: " + assessed + "/" + jobs.length + " eligible pairs; " + (leaves.length * targets.length - jobs.length) + " structural rejections.", "field_assessment", assessed, jobs.length);
        });
        timings.classificationMs = Math.round(performance.now() - classifyStarted);
        const selectionStarted = performance.now();
        const choose = async (target, candidates, pass) => {
          const decision = { id: "d" + requestId++, kind: "choose", target: { id: target, ...LAYA_TARGET_CATALOGUE[target] }, candidates, maxCandidates: 16 };
          const [result] = await evaluate([decision]);
          provenance[target].comparisons.push({ pass, candidateIds: candidates.slice(0, result.consumed).map((c) => c.id), choice: result.choice, probabilities: result.probabilities, tokenAccounting: result.tokenAccounting });
          return result;
        };
        await parallelJobs(targets, runtime?.effectiveWorkers || 1, async (target) => {
          const trace = provenance[target];
          trace.candidates.sort((a, b) => b.score - a.score || compare(a.pointer, b.pointer));
          const records = new Map(candidatesByTarget.get(target).map((field) => [field.id, field]));
          let bucket = trace.candidates.map((item) => ({ ...records.get(item.id), evidence: item.evidence, score: item.score }));
          const sweep = async (ordered, pass) => {
            let offset = 0, winner;
            while (offset < ordered.length) {
              const limit = 16;
              const candidates = [...(winner ? [winner] : []), ...ordered.slice(offset, offset + limit - (winner ? 1 : 0))];
              const result = await choose(target, candidates, pass);
              const increment = result.consumed - (winner ? 1 : 0);
              if (increment < 1) throw new Error("Laya could not assess the next candidate.");
              offset += increment;
              winner = result.choice === NONE ? undefined : candidates.find((c) => c.id === result.choice);
              progress("Final assessment " + target + ": " + pass + " " + offset + "/" + ordered.length + " fields.", "final_assessment", offset, ordered.length, { target, pass });
            }
            return winner;
          };
          const select = async (items, prefix = "") => {
            const forward = await sweep(items, prefix + "forward");
            const reverse = await sweep([...items].reverse(), prefix + "reverse");
            const nominees = [forward?.id || NONE, reverse?.id || NONE];
            const disagreement = forward?.id !== reverse?.id;
            let selected = forward;
            if (disagreement) {
              const distinct = [...new Map([forward, reverse].filter(Boolean).map((item) => [item.id, item])).values()];
              const votes = new Map(distinct.map((item) => [item.id, 0]));
              for (const candidates of [distinct, [...distinct].reverse()]) {
                const result = await choose(target, candidates, prefix + "adjudication");
                if (result.consumed !== candidates.length) throw new Error("Laya could not fit both nominees.");
                if (votes.has(result.choice)) votes.set(result.choice, votes.get(result.choice) + 1);
              }
              distinct.sort((a, b) => votes.get(b.id) - votes.get(a.id) || b.score - a.score || compare(a.pointer, b.pointer));
              selected = distinct[0];
            }
            return { selected, nominees, disagreement, valueAgreement: forward && reverse ? valueIdentity(forward) === valueIdentity(reverse) : !forward && !reverse };
          };
          if (options.groupValues) {
            const groups = new Map();
            for (const field of bucket) {
              const identity = valueIdentity(field);
              if (!groups.has(identity)) groups.set(identity, []);
              groups.get(identity).push(field);
            }
            bucket = [];
            for (const members of groups.values()) {
              const id = "g" + createHash("sha256").update(valueIdentity(members[0])).digest("hex").slice(0, 20);
              const selection = members.length > 1 ? await select(members, "aliases:" + id + ":") : { selected: members[0], nominees: [members[0].id, members[0].id], disagreement: false };
              // A negative alias comparison cannot exclude a value from final assessment.
              // The fallback is explicitly unendorsed, and all member comparisons remain visible.
              const representative = selection.selected || members[0];
              trace.groups.push({ id, memberIds: members.map((m) => m.id), memberPointers: members.map((m) => m.pointer), representativeId: representative.id, nominees: selection.nominees, disagreement: selection.disagreement, pointerAgreement: !selection.disagreement && Boolean(selection.selected), modelSelectedRepresentative: Boolean(selection.selected) });
              bucket.push({ ...representative, groupId: id });
            }
            bucket.sort((a, b) => b.score - a.score || compare(a.pointer, b.pointer));
          }
          const selection = await select(bucket);
          const selected = selection.selected;
          const selectedGroup = trace.groups.find((g) => g.id === selected?.groupId);
          trace.nominees = selection.nominees;
          trace.pointerNominees = selectedGroup?.nominees || selection.nominees;
          const unresolvedPointer = Boolean(selectedGroup && !selectedGroup.modelSelectedRepresentative);
          trace.disagreements = selection.disagreement || Boolean(selectedGroup?.disagreement);
          trace.agreement = { value: !selected ? "none" : selection.valueAgreement ? "agreed" : "disagreed", pointer: !selected ? "none" : unresolvedPointer ? "unresolved" : trace.disagreements ? "disagreed" : "agreed" };
          let targetStatus = !selected ? "no_supported_match" : trace.disagreements || unresolvedPointer ? "tentative" : "selected";
          if (selected) {
            fields[target] = resolveAlertPointer(documents, selected.pointer);
            paths[target] = trace.selectedPointer = selected.pointer;
          }
          statuses[target] = targetStatus;
        });
        timings.selectionMs = Math.round(performance.now() - selectionStarted);
      } catch (error) {
        runner.close?.();
        cancelled(signal);
        failure = error instanceof Error ? error.message : String(error);
      } finally { signal?.removeEventListener("abort", abort); }
      for (const target of targets) {
        provenance[target].candidates.sort((a, b) => b.score - a.score || compare(a.pointer, b.pointer));
        provenance[target].assessedIds = [...new Set(provenance[target].comparisons.flatMap((entry) => entry.candidateIds))].sort(compare);
      }
      const warnings = [];
      if (!complete) warnings.push("Source-document coverage was incomplete.");
      if (failure) warnings.push("Model processing incomplete: " + failure);
      const tentative = targets.filter((target) => statuses[target] === "tentative");
      if (tentative.length) warnings.push("Tentative best guesses; review order disagreement and alias ambiguity: " + tentative.join(", ") + ".");
      timings.totalMs = Math.round(performance.now() - started);
      const processingComplete = !failure && targets.every((target) => statuses[target] !== "incomplete");
      const coverage = Object.fromEntries(targets.map((target) => {
        const trace = provenance[target];
        return [target, { totalFields: leaves.length, eligible: candidatesByTarget.get(target).length, distinctValues: new Set(candidatesByTarget.get(target).map(valueIdentity)).size, rejected: trace.rejected.length, scored: trace.candidates.length, finalAssessed: trace.assessedIds.length, windowsEvaluated: trace.candidates.reduce((n, c) => n + c.windows.length, 0), omittedContext: trace.candidates.reduce((n, c) => n + c.windows.reduce((m, w) => m + (w.tokenAccounting?.omittedSiblings || 0), 0), 0) }];
      }));
      progress(processingComplete ? "Completed field mapping; review selected and tentative results." : "Mapping ended with incomplete model coverage.", processingComplete ? "complete" : "incomplete", 1, 1);
      return { fields, paths, statuses, provenance, coverage, warning: warnings.join(" "), complete: complete && processingComplete, sourceComplete: complete, processingComplete, leaves: leaves.length, decisionsCompleted, model: LAYA_MODEL, experiment, runtime, timings, scoreMeaning: "Model scores are not calibrated correctness estimates." };
    }
  };
}
