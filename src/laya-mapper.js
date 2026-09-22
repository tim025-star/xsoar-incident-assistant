import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const DEFAULT_LAYA_CHECKPOINT = "base-multilingual";
export const LAYA_MAPPER_TARGETS = Object.freeze([
  "customerName", "classification", "occurred", "incidentOutcome", "closeNotes", "ruleName",
  "caseType", "clientIp", "clientHostname", "clientUserName", "destinationIp", "deviceHostname",
  "eventInfo", "eventName", "detectionUrl", "errorMessage", "serviceMessage", "sourceHostname",
  "sourceIp", "sourceUsername", "descriptionLong", "historicalSummary", "historicalRecommendations"
]);

export const HISTORIC_LAYA_TARGETS = Object.freeze([
  "customerName", "ruleName", "caseType", "incidentOutcome", "closeNotes", "historicalRecommendations"
]);

const TARGET_DESCRIPTIONS = Object.freeze({
  customerName: "the customer or organisation display name",
  classification: "the recorded incident classification",
  occurred: "the time at which the event occurred",
  incidentOutcome: "the factual incident outcome",
  closeNotes: "the incident closure notes",
  ruleName: "the detection or rule name used to find equivalent incidents",
  caseType: "the incident, case, event, or alert type",
  clientIp: "the client IP address",
  clientHostname: "the client host name",
  clientUserName: "the client user name",
  destinationIp: "the destination IP address",
  deviceHostname: "the affected device host name",
  eventInfo: "the original event information",
  eventName: "the event display name",
  detectionUrl: "the URL of the source detection or event record",
  errorMessage: "the source error message",
  serviceMessage: "the source service message",
  sourceHostname: "the source host name",
  sourceIp: "the source IP address from which the activity originated",
  sourceUsername: "the source user or principal name",
  descriptionLong: "the long factual event description",
  historicalSummary: "the historic incident summary",
  historicalRecommendations: "the factual historic resolution or recommendations"
});

const MAX_DOCUMENT_BYTES = 96 * 1024;
const MAX_LEAVES = 10000;
const MAX_DEPTH = 30;
const DEFAULT_CHUNK_TOKENS = 700;
const DEFAULT_MAX_CHOICES = 6;
const MAX_RUNNER_LINE_BYTES = 4 * 1024 * 1024;
const RUNNER_TIMEOUT_MS = 180000;

export const layaMapperSettingsSchema = z.object({
  enabled: z.boolean(),
  checkpointId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/)
}).strict();

function escapePointerPart(value) { return String(value).replaceAll("~", "~0").replaceAll("/", "~1"); }
function unescapePointerPart(value) { return value.replaceAll("~1", "/").replaceAll("~0", "~"); }

export function flattenAlertDocuments(documents) {
  if (!Array.isArray(documents)) throw new Error("Laya-mapper requires an array of alert JSON documents.");
  const serialized = JSON.stringify(documents);
  if (Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES) throw new Error("The detailed alert JSON exceeds the Laya-mapper processing limit.");
  const leaves = [];
  let visited = 0;
  const visit = (value, parts, depth) => {
    if (depth > MAX_DEPTH || ++visited > MAX_LEAVES) throw new Error("The detailed alert JSON is too complex for Laya-mapper.");
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...parts, String(index)], depth + 1));
      return;
    }
    if (value !== null && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => visit(item, [...parts, key], depth + 1));
      return;
    }
    leaves.push({
      id: `leaf-${leaves.length}`,
      pointer: `/${parts.map(escapePointerPart).join("/")}`,
      ancestry: parts.slice(0, -1),
      key: parts.at(-1) || "",
      value
    });
  };
  documents.forEach((document, index) => visit(document, ["documents", String(index)], 0));
  return leaves;
}

export function resolveAlertPointer(documents, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/documents/")) return undefined;
  const parts = pointer.slice(1).split("/").map(unescapePointerPart);
  let value = { documents };
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function scalarText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value.trim() : String(value);
}

function validMappedValue(target, value) {
  const text = scalarText(value);
  if (!text || text.length > 10000) return false;
  if (["sourceIp", "clientIp", "destinationIp"].includes(target)) return net.isIP(text) > 0;
  if (target === "detectionUrl") {
    try { return ["http:", "https:"].includes(new URL(text).protocol); } catch { return false; }
  }
  if (target === "occurred") return Number.isFinite(Number(value)) || Number.isFinite(Date.parse(text));
  return true;
}

function fallbackTokenCount(value) { return Math.ceil(JSON.stringify(value).length / 3); }

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new Error("Laya-mapper operation was cancelled.");
}

function reportProgress(onProgress, detail) {
  try { onProgress?.({ detail }); } catch {}
}

async function mechanicallyChunk(leaves, runner, maxTokens, { onProgress, signal } = {}) {
  const chunks = [];
  let current = [];
  for (let leafIndex = 0; leafIndex < leaves.length; leafIndex += 1) {
    throwIfCancelled(signal);
    reportProgress(onProgress, `Preparing JSON leaf ${leafIndex + 1} of ${leaves.length} for context-safe chunks.`);
    const leaf = leaves[leafIndex];
    const proposed = [...current, leaf];
    let count;
    if (typeof runner.countTokens === "function") {
      try { count = await runner.countTokens({ leaves: proposed }); } catch {}
    }
    count ??= fallbackTokenCount({ leaves: proposed });
    if (current.length && count > maxTokens) {
      chunks.push({ id: `chunk-${chunks.length}`, leaves: current });
      current = [leaf];
    } else current = proposed;
  }
  if (current.length) chunks.push({ id: `chunk-${chunks.length}`, leaves: current });
  return chunks;
}

function normalizeRelevance(response, targets) {
  return Object.fromEntries(targets.map((target) => {
    const score = Number(response?.[target]);
    return [target, Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0];
  }));
}

function normalizeRankings(response, candidates) {
  const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const rankings = Array.isArray(response?.rankings) ? response.rankings : [];
  return rankings
    .map((item) => ({ candidate: allowed.get(String(item?.id)), score: Number(item?.score) }))
    .filter((item) => item.candidate && Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);
}

async function chooseBatch(runner, target, candidates, contextLeaves) {
  const response = await runner.choose({
    target,
    description: TARGET_DESCRIPTIONS[target] || target,
    candidates: candidates.map(({ id, pointer, ancestry, key, value }) => ({ id, pointer, ancestry, key, value })),
    context: contextLeaves.map(({ id, pointer, ancestry, key, value }) => ({ id, pointer, ancestry, key, value }))
  });
  return normalizeRankings(response, candidates);
}

async function adjudicate(runner, target, candidates, maxChoices) {
  let round = [...candidates];
  while (round.length > maxChoices) {
    const winners = [];
    for (let index = 0; index < round.length; index += maxChoices) {
      const batch = round.slice(index, index + maxChoices);
      const ranked = await chooseBatch(runner, target, batch, batch);
      if (ranked[0]) winners.push(ranked[0].candidate);
    }
    round = winners;
  }
  return chooseBatch(runner, target, round, round);
}

export function createLayaMapper({
  runner = createLayaSidecarRunner(),
  maxChunkTokens = DEFAULT_CHUNK_TOKENS,
  maxChoices = DEFAULT_MAX_CHOICES
} = {}) {
  return {
    status: () => runner.status(),
    close: () => runner.close?.(),
    async mapIncident({
      documents,
      targets = LAYA_MAPPER_TARGETS,
      checkpointId = DEFAULT_LAYA_CHECKPOINT,
      complete = true,
      onProgress,
      signal
    }) {
      targets = [...new Set(targets)].filter((target) => LAYA_MAPPER_TARGETS.includes(target));
      if (!targets.length) return { fields: {}, paths: {}, provenance: {}, warning: "", complete };
      throwIfCancelled(signal);
      reportProgress(onProgress, "Flattening every scalar JSON leaf without semantic filtering.");
      const leaves = flattenAlertDocuments(documents);
      if (!leaves.length) throw new Error("Laya-mapper could not find scalar values in the detailed alert JSON.");
      reportProgress(onProgress, `Loading checkpoint ${checkpointId} on the local model process.`);
      await runner.useCheckpoint?.(checkpointId);
      throwIfCancelled(signal);
      const chunks = await mechanicallyChunk(leaves, runner, maxChunkTokens, { onProgress, signal });
      reportProgress(onProgress, `Prepared ${leaves.length} leaves in ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}.`);
      const relevanceByChunk = new Map();
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        throwIfCancelled(signal);
        const chunk = chunks[chunkIndex];
        reportProgress(onProgress, `Round 1: ranking chunk ${chunkIndex + 1} of ${chunks.length} for ${targets.length} requested field${targets.length === 1 ? "" : "s"}.`);
        relevanceByChunk.set(chunk.id, normalizeRelevance(await runner.relevance({
          checkpointId,
          chunk: { id: chunk.id, leaves: chunk.leaves },
          targets: targets.map((target) => ({ id: target, description: TARGET_DESCRIPTIONS[target] || target }))
        }), targets));
      }

      const fields = {};
      const paths = {};
      const provenance = {};
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        throwIfCancelled(signal);
        const target = targets[targetIndex];
        const orderedChunks = chunks.map((chunk) => ({ chunk, score: relevanceByChunk.get(chunk.id)[target] }))
          .sort((a, b) => b.score - a.score);
        const relevant = orderedChunks.filter(({ score }) => score >= 0.5);
        if (!relevant.length && orderedChunks[0]) relevant.push(orderedChunks[0]);
        const winners = [];
        const inspectedChunks = [];
        const batchRankings = [];
        for (let relevantIndex = 0; relevantIndex < relevant.length; relevantIndex += 1) {
          const { chunk, score } = relevant[relevantIndex];
          inspectedChunks.push({ id: chunk.id, score, pointers: chunk.leaves.map((leaf) => leaf.pointer) });
          for (let index = 0; index < chunk.leaves.length; index += maxChoices) {
            throwIfCancelled(signal);
            const candidates = chunk.leaves.slice(index, index + maxChoices);
            const batchNumber = Math.floor(index / maxChoices) + 1;
            const batchCount = Math.ceil(chunk.leaves.length / maxChoices);
            reportProgress(onProgress, `Round 2: mapping ${target} (${targetIndex + 1}/${targets.length}), relevant chunk ${relevantIndex + 1}/${relevant.length}, candidate batch ${batchNumber}/${batchCount}.`);
            const ranked = await chooseBatch(runner, target, candidates, chunk.leaves);
            batchRankings.push({
              chunkId: chunk.id,
              rankings: ranked.map(({ candidate, score }) => ({ id: candidate.id, pointer: candidate.pointer, score }))
            });
            const bestValid = ranked.find(({ candidate }) => validMappedValue(
              target,
              resolveAlertPointer(documents, candidate.pointer)
            ));
            if (bestValid) winners.push(bestValid.candidate);
          }
        }
        throwIfCancelled(signal);
        reportProgress(onProgress, `Final comparison for ${target} (${targetIndex + 1}/${targets.length}) across ${winners.length} batch winner${winners.length === 1 ? "" : "s"}.`);
        const ranked = winners.length ? await adjudicate(runner, target, winners, maxChoices) : [];
        const selected = ranked.find(({ candidate }) => {
          const value = resolveAlertPointer(documents, candidate.pointer);
          return validMappedValue(target, value);
        });
        if (selected) {
          fields[target] = scalarText(resolveAlertPointer(documents, selected.candidate.pointer));
          paths[target] = selected.candidate.pointer;
        }
        provenance[target] = {
          relevantChunks: inspectedChunks,
          batchRankings,
          rankings: ranked.map(({ candidate, score }) => ({ id: candidate.id, pointer: candidate.pointer, score })),
          selectedPointer: selected?.candidate.pointer || ""
        };
      }
      const missing = targets.filter((target) => !fields[target]);
      const warnings = [];
      if (!complete) warnings.push("Detailed alert JSON coverage was incomplete; Laya-mapper used the available documents.");
      if (missing.length) warnings.push(`Laya-mapper did not select valid values for: ${missing.join(", ")}.`);
      reportProgress(onProgress, `Completed mapping ${targets.length} requested field${targets.length === 1 ? "" : "s"}.`);
      return { fields, paths, provenance, warning: warnings.join(" "), complete, chunks: chunks.length, leaves: leaves.length };
    }
  };
}

function defaultRunnerPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "XSOAR Incident Assistant", "laya-mapper", "runtime", "laya-mapper.exe");
}

export function createLayaSidecarRunner({ executable = defaultRunnerPath(), spawnImplementation = spawn, timeoutMs = RUNNER_TIMEOUT_MS } = {}) {
  let child;
  let buffered = "";
  let stderrBytes = 0;
  const pending = new Map();
  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  const start = async () => {
    if (child && !child.killed) return child;
    await access(executable).catch(() => { throw new Error("Laya-mapper is not installed."); });
    child = spawnImplementation(executable, ["serve"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        HF_DATASETS_OFFLINE: "1",
        LAYA_MAPPER_OFFLINE: "1"
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_RUNNER_LINE_BYTES) {
        child.kill();
        failAll(new Error("Laya-mapper returned an oversized response."));
        return;
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch {
          failAll(new Error("Laya-mapper returned an invalid response."));
          continue;
        }
        const request = pending.get(response.id);
        if (!request) continue;
        pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error("Laya-mapper could not process the alert."));
        else request.resolve(response.result);
      }
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) child.stderr.pause(); });
    child.once("error", () => failAll(new Error("Laya-mapper is unavailable.")));
    child.once("exit", () => { child = undefined; failAll(new Error("Laya-mapper stopped unexpectedly.")); });
    return child;
  };
  const request = async (action, input = {}) => {
    const process = await start();
    const id = randomUUID();
    const line = `${JSON.stringify({ id, action, input })}\n`;
    if (Buffer.byteLength(line) > MAX_RUNNER_LINE_BYTES) throw new Error("Laya-mapper request was too large.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Laya-mapper timed out."));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      process.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("Laya-mapper is unavailable."));
      });
    });
  };
  return {
    async status() {
      try { await access(executable); const result = await request("status"); return { available: true, ...result }; }
      catch (error) { return { available: false, detail: error instanceof Error ? error.message : "Laya-mapper is unavailable.", checkpoints: [] }; }
    },
    countTokens: (input) => request("countTokens", input),
    useCheckpoint: (checkpointId) => request("useCheckpoint", { checkpointId }),
    relevance: (input) => request("relevance", input),
    choose: (input) => request("choose", input),
    close() { if (child) child.kill(); child = undefined; }
  };
}
