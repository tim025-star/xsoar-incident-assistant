import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MINIMUM_TRAINING_EXAMPLES = 50;
const ALLOWED_CHECKPOINT_FILES = new Set([
  "manifest.json", "model.safetensors", "rl_agent_config.json",
  "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json",
  "tokenizer/special_tokens_map.json", "tokenizer/vocab.txt"
]);

function defaultLayaDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "XSOAR Incident Assistant", "laya-mapper");
}

async function exists(filePath) { try { await access(filePath); return true; } catch { return false; } }
async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function boundedFile(filePath, maximumBytes = 1024 * 1024) {
  if ((await stat(filePath)).size > maximumBytes) throw new Error("Laya checkpoint metadata is too large.");
  return readFile(filePath, "utf8");
}
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function collectRelativeFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await collectRelativeFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    else throw new Error("Laya checkpoint bundles may contain only regular files and directories.");
  }
  return files;
}

async function validateCheckpoint(directory) {
  const files = await collectRelativeFiles(directory);
  if (!files.includes("manifest.json") || !files.includes("model.safetensors") || !files.includes("rl_agent_config.json")) {
    throw new Error("The Laya checkpoint bundle is incomplete.");
  }
  const unexpected = files.filter((file) => !ALLOWED_CHECKPOINT_FILES.has(file));
  if (unexpected.length) throw new Error(`The Laya checkpoint bundle contains unsupported files: ${unexpected.join(", ")}.`);
  const manifest = JSON.parse(await boundedFile(path.join(directory, "manifest.json")));
  if (manifest?.schemaVersion !== 1 || !/^[A-Za-z0-9._-]{1,128}$/.test(String(manifest.id || ""))) {
    throw new Error("The Laya checkpoint manifest is invalid.");
  }
  if (manifest.base !== "laya-multilingual") throw new Error("The Laya checkpoint uses an unsupported base model.");
  return manifest;
}

export function createLayaTrainingManager({
  datasetStore,
  rootDirectory = defaultLayaDirectory(),
  spawnImplementation = spawn
} = {}) {
  if (!datasetStore) throw new Error("A Laya dataset store is required.");
  const trainerPath = path.join(rootDirectory, "training-runtime", "laya-trainer.exe");
  const baseModelDirectory = path.join(rootDirectory, "models", "base-multilingual");
  const checkpointsDirectory = path.join(rootDirectory, "checkpoints");
  const runsDirectory = path.join(rootDirectory, "training-runs");
  let activeRun;
  let lastRun;

  const listCheckpoints = async () => {
    let names;
    try { names = await readdir(checkpointsDirectory); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const values = [];
    for (const name of names.sort()) {
      const directory = path.join(checkpointsDirectory, name);
      try { values.push(await validateCheckpoint(directory)); } catch {}
    }
    return values;
  };

  const status = async () => ({
    trainerInstalled: await exists(trainerPath),
    trainingBackend: await readFile(path.join(rootDirectory, "training-runtime", "install.json"), "utf8")
      .then((value) => JSON.parse(value)?.backend).catch(() => undefined),
    running: Boolean(activeRun),
    run: activeRun ? { id: activeRun.id, detail: activeRun.detail, progress: activeRun.progress } : undefined,
    lastRun,
    checkpoints: await listCheckpoints(),
    minimumExamples: MINIMUM_TRAINING_EXAMPLES,
    examples: (await datasetStore.list()).length
  });

  return {
    status,
    listCheckpoints,
    async waitForCompletion(id) {
      if (activeRun?.id === id) return activeRun.completion;
      if (lastRun?.id === id) return lastRun;
      throw new Error("The Laya fine-tuning run was not found.");
    },
    async start({ device = "auto", resumeRunId } = {}) {
      if (activeRun) throw new Error("Laya fine-tuning is already running.");
      if (!await exists(trainerPath)) throw new Error("Install the Laya fine-tuning tools before training.");
      if (!await exists(baseModelDirectory)) throw new Error("Install Laya-mapper before training.");
      const id = resumeRunId || randomUUID();
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Laya fine-tuning run ID.");
      const runDirectory = path.join(runsDirectory, id);
      const outputDirectory = path.join(runDirectory, "output");
      if (resumeRunId) {
        if (!await exists(path.join(runDirectory, "dataset.jsonl"))
          || !await exists(path.join(runDirectory, "training-config.json"))
          || !await exists(path.join(runDirectory, "checkpoint_latest", "model.safetensors"))) {
          throw new Error("The Laya fine-tuning run has no resumable rolling checkpoint.");
        }
      } else {
        const examples = await datasetStore.list();
        if (examples.length < MINIMUM_TRAINING_EXAMPLES) {
          throw new Error(`Laya fine-tuning requires at least ${MINIMUM_TRAINING_EXAMPLES} labeled alerts.`);
        }
        await mkdir(runDirectory, { recursive: true });
        await writeFile(path.join(runDirectory, "dataset.jsonl"), await datasetStore.exportJsonl(), { encoding: "utf8", mode: 0o600 });
        await atomicJson(path.join(runDirectory, "training-config.json"), {
          schemaVersion: 1,
          splitSeed: 42,
          validationFraction: 0.2,
          minimumExamples: MINIMUM_TRAINING_EXAMPLES,
          device
        });
      }
      const arguments_ = [
        "train",
        "--dataset", path.join(runDirectory, "dataset.jsonl"),
        "--config", path.join(runDirectory, "training-config.json"),
        "--base", baseModelDirectory,
        "--output", outputDirectory,
        "--device", device
      ];
      if (resumeRunId) arguments_.push("--resume");
      const child = spawnImplementation(trainerPath, arguments_, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" }
      });
      activeRun = { id, child, detail: "Starting Laya fine-tuning.", progress: 0 };
      let buffered = "";
      let stderrBytes = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() || "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (activeRun?.id !== id) continue;
            activeRun.detail = String(event.detail || activeRun.detail).slice(0, 500);
            activeRun.progress = Math.max(0, Math.min(100, Number(event.progress) || 0));
          } catch {}
        }
      });
      child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) child.stderr.pause(); });
      const completion = new Promise((resolve, reject) => {
        child.once("error", () => reject(new Error("The Laya trainer could not start.")));
        child.once("exit", async (code) => {
          const cancelled = activeRun?.cancelled;
          activeRun = undefined;
          if (cancelled) return reject(new Error("Laya fine-tuning was cancelled."));
          if (code !== 0) return reject(new Error("Laya fine-tuning failed."));
          try {
            const manifest = await validateCheckpoint(outputDirectory);
            const finalDirectory = path.join(checkpointsDirectory, manifest.id);
            await mkdir(checkpointsDirectory, { recursive: true });
            await rm(finalDirectory, { recursive: true, force: true });
            await rename(outputDirectory, finalDirectory);
            resolve(manifest);
          } catch (error) { reject(error); }
        });
      });
      activeRun.completion = completion;
      completion.then((manifest) => { lastRun = { id, status: "complete", manifest }; })
        .catch((error) => { lastRun = { id, status: /cancelled/i.test(error.message) ? "cancelled" : "failed", detail: error.message }; });
      return { id };
    },
    async cancel() {
      if (!activeRun) throw new Error("No Laya fine-tuning run is active.");
      activeRun.cancelled = true;
      activeRun.child.kill();
    },
    async removeCheckpoint(id) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id === "base-multilingual") throw new Error("Invalid Laya checkpoint ID.");
      await rm(path.join(checkpointsDirectory, id), { recursive: true, force: true });
    },
    async importCheckpoint(sourceDirectory) {
      sourceDirectory = path.resolve(sourceDirectory);
      const manifest = await validateCheckpoint(sourceDirectory);
      const destination = path.join(checkpointsDirectory, manifest.id);
      await mkdir(checkpointsDirectory, { recursive: true });
      await rm(destination, { recursive: true, force: true });
      await cp(sourceDirectory, destination, { recursive: true, errorOnExist: true });
      return manifest;
    },
    async exportCheckpoint(id, destinationDirectory) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id === "base-multilingual") throw new Error("Invalid Laya checkpoint ID.");
      const source = path.join(checkpointsDirectory, id);
      await validateCheckpoint(source);
      destinationDirectory = path.resolve(destinationDirectory);
      if (await exists(destinationDirectory)) throw new Error("Choose an empty destination for the Laya checkpoint export.");
      await cp(source, destinationDirectory, { recursive: true, errorOnExist: true });
      return destinationDirectory;
    },
    async exportTrainingBundle(destinationDirectory) {
      destinationDirectory = path.resolve(destinationDirectory);
      if (await exists(destinationDirectory)) throw new Error("Choose an empty destination for the Laya training bundle.");
      await mkdir(destinationDirectory, { recursive: true });
      await Promise.all([
        cp(trainerPath, path.join(destinationDirectory, "laya-trainer.exe")),
        cp(baseModelDirectory, path.join(destinationDirectory, "base-model"), { recursive: true }),
        writeFile(path.join(destinationDirectory, "dataset.jsonl"), await datasetStore.exportJsonl(), { encoding: "utf8", mode: 0o600 }),
        atomicJson(path.join(destinationDirectory, "training-config.json"), {
          schemaVersion: 1,
          splitSeed: 42,
          validationFraction: 0.2,
          minimumExamples: MINIMUM_TRAINING_EXAMPLES,
          device: "auto"
        })
      ]);
      const bundleFiles = [];
      for (const relative of await collectRelativeFiles(destinationDirectory)) {
        const filePath = path.join(destinationDirectory, ...relative.split("/"));
        const details = await stat(filePath);
        bundleFiles.push({
          path: relative,
          size: details.size,
          sha256: await sha256File(filePath)
        });
      }
      await atomicJson(path.join(destinationDirectory, "manifest.json"), {
        schemaVersion: 1,
        kind: "xsoar-laya-offline-training-bundle",
        createdAt: new Date().toISOString(),
        layaVersion: "0.3.5",
        files: bundleFiles
      });
      return destinationDirectory;
    }
  };
}

export { MINIMUM_TRAINING_EXAMPLES };
