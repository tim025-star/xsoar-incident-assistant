import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function fileSha256(file) {
  return sha256(await readFile(file));
}

export function caseTargetSetSha256(cases) {
  return sha256(canonical(cases.map((entry) => ({
    id: entry.id || entry.sampleId,
    targets: [...entry.targets].sort()
  })).sort((left, right) => left.id.localeCompare(right.id))));
}

export function runtimeContract(runtime) {
  return {
    protocolVersion: runtime?.protocolVersion,
    sdkVersion: runtime?.sdkVersion,
    model: {
      id: runtime?.model?.id,
      repository: runtime?.model?.repository,
      revision: runtime?.model?.revision,
      sdkVersion: runtime?.model?.sdkVersion,
    },
    promptVersion: runtime?.promptVersion,
    effectiveWorkers: runtime?.effectiveWorkers,
    threadsPerWorker: runtime?.threadsPerWorker,
    workerMode: runtime?.workerMode,
    requestedWorkers: runtime?.requestedWorkers,
  };
}

export function assertStableRuntimeIdentity(expected, runtime) {
  const actual = runtimeContract(runtime);
  if (canonical(actual) !== canonical(expected)) throw new Error("Evaluation runtime identity changed within the report.");
}

export async function implementationSha256(root, evaluatorFile) {
  const files = [evaluatorFile, "scripts/laya-evaluation-identity.mjs", "src/laya-mapper.js", "src/laya-worker.js", "src/laya-targets.js", "laya-mapper/runner.py"];
  const content = await Promise.all(files.map(async (relative) => [relative, await readFile(path.join(root, relative), "utf8")]));
  return sha256(canonical(content));
}
