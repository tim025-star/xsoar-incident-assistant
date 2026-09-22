import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createLayaMapperInstaller, extractLayaArchive, parseLayaInstallManifest } from "../src/laya-mapper-installer.js";
import { createLayaTrainingManager, MINIMUM_TRAINING_EXAMPLES } from "../src/laya-training.js";
import { LAYA_MODEL } from "../src/laya-targets.js";

const digest = "a".repeat(64);
const asset = (name, size = 4) => ({
  name,
  size,
  sha256: digest,
  url: `https://github.com/example/laya-assets/releases/download/v1/${name}`
});
const manifest = {
  schemaVersion: 2,
  layaVersion: "0.3.5",
  runtime: { ...asset("laya-mapper-runtime-cpu-x64.tar.gz"), entry: "laya-mapper.exe" },
  trainers: {
    cpu: { ...asset("laya-trainer-cpu-x64.tar.gz"), entry: "laya-trainer.exe" },
    cuda: { ...asset("laya-trainer-cuda-x64.tar.gz"), entry: "laya-trainer.exe" }
  },
  modelFiles: [{ ...asset("model.safetensors"), path: "model.safetensors" }]
};

test("English inference manifest requires the pinned identity and no trainer assets", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-english-install-"));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const baseline = { ...manifest, schemaVersion: 3, protocolVersion: 2, model: LAYA_MODEL };
  delete baseline.trainers;
  assert.deepEqual(parseLayaInstallManifest(baseline).trainers, {});
  assert.throws(() => parseLayaInstallManifest({ ...baseline, model: { ...LAYA_MODEL, revision: "wrong" } }), /identity/);
  const destinations = [];
  const installer = createLayaMapperInstaller({ manifest: baseline, rootDirectory,
    download: async (asset, destination) => { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, Buffer.alloc(asset.size)); },
    extract: async (_, destination) => { destinations.push(destination); }
  });
  assert.deepEqual(await installer.installInference(), { installed: true, checkpointId: "base-english" });
  assert.deepEqual(destinations, [path.join(rootDirectory, "runtime-v2")]);
  await access(path.join(rootDirectory, "models/base-english/model.safetensors"));
  await assert.rejects(installer.installTrainingTools({ backend: "cpu" }), /unavailable/);
});

test("Laya installation accepts only bounded GitHub release assets and installs verified files", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-install-"));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const downloaded = [];
  const installer = createLayaMapperInstaller({
    manifest,
    rootDirectory,
    download: async (requested, destination, { onProgress }) => {
      downloaded.push(requested.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.alloc(requested.size));
      onProgress?.({ completed: requested.size, total: requested.size });
    },
    extract: async (_archive, destination, entry) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, entry), "fixture");
    },
    detectTrainingBackend: async () => "cpu"
  });
  assert.deepEqual(await installer.installInference(), { installed: true, checkpointId: "base-multilingual" });
  assert.deepEqual(downloaded, ["laya-mapper-runtime-cpu-x64.tar.gz", "model.safetensors"]);
  assert.deepEqual(await installer.installTrainingTools(), { installed: true, backend: "cpu" });
  assert.deepEqual(downloaded, ["laya-mapper-runtime-cpu-x64.tar.gz", "model.safetensors", "laya-trainer-cpu-x64.tar.gz"]);
  assert.throws(() => parseLayaInstallManifest({
    ...manifest,
    runtime: { ...manifest.runtime, name: "../outside.exe" }
  }), /invalid asset name/i);
  assert.throws(() => parseLayaInstallManifest({
    ...manifest,
    runtime: { ...manifest.runtime, url: "https://example.com/laya-mapper.exe" }
  }), /GitHub release URLs/i);
});

test("Laya installation works from an offline asset pack and preserves both trainers", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-offline-install-"));
  const offlineDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-offline-assets-"));
  context.after(() => Promise.all([
    rm(rootDirectory, { recursive: true, force: true }),
    rm(offlineDirectory, { recursive: true, force: true })
  ]));
  const contents = Buffer.from("test");
  const offlineManifest = JSON.parse(JSON.stringify(manifest));
  const checksum = createHash("sha256").update(contents).digest("hex");
  for (const item of [offlineManifest.runtime, ...Object.values(offlineManifest.trainers), ...offlineManifest.modelFiles]) {
    item.size = contents.length;
    item.sha256 = checksum;
    await writeFile(path.join(offlineDirectory, item.name), contents);
  }
  const installer = createLayaMapperInstaller({
    manifest: offlineManifest,
    rootDirectory,
    offlineDirectories: [offlineDirectory],
    download: async () => { throw new Error("network download was not expected"); },
    extract: async (_archive, destination, entry) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, entry), "fixture");
    },
    detectTrainingBackend: async () => "cpu"
  });
  await installer.installInference();
  await Promise.all(Object.values(offlineManifest.trainers).map((item) =>
    access(path.join(rootDirectory, "offline-assets", item.name))
  ));
  assert.deepEqual(await installer.installTrainingTools(), { installed: true, backend: "cpu" });
});

test("Laya runtime extraction rejects archive traversal before writing files", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-archive-"));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const spawnImplementation = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end("../outside.exe\n");
      child.emit("exit", 0);
    });
    return child;
  };
  await assert.rejects(
    extractLayaArchive("fixture.tar.gz", path.join(rootDirectory, "runtime"), "laya-mapper.exe", { spawnImplementation }),
    /unsafe path/i
  );
});

test("Laya runtime extraction permits the normal tar archive root marker", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-archive-root-"));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  let invocation = 0;
  const spawnImplementation = (_executable, arguments_) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(async () => {
      if (invocation++ === 0) child.stdout.end("./\n./laya-mapper.exe\n");
      else {
        await writeFile(path.join(arguments_.at(-1), "laya-mapper.exe"), "fixture");
        child.stdout.end();
      }
      child.emit("exit", 0);
    });
    return child;
  };
  await extractLayaArchive("fixture.tar.gz", path.join(rootDirectory, "runtime"), "laya-mapper.exe", { spawnImplementation });
  await access(path.join(rootDirectory, "runtime", "laya-mapper.exe"));
});

test("Laya training enforces the alert-level minimum before starting", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-training-"));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  await mkdir(path.join(rootDirectory, "training-runtime"), { recursive: true });
  await mkdir(path.join(rootDirectory, "models", "base-multilingual"), { recursive: true });
  await writeFile(path.join(rootDirectory, "training-runtime", "laya-trainer.exe"), "fixture");
  const datasetStore = {
    list: async () => Array.from({ length: MINIMUM_TRAINING_EXAMPLES - 1 }, (_, index) => ({ id: String(index) })),
    exportJsonl: async () => ""
  };
  const training = createLayaTrainingManager({ datasetStore, rootDirectory });
  await assert.rejects(training.start(), /at least 50 labeled alerts/i);
});

test("checkpoint import rejects executable and pickle content", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-checkpoints-"));
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-checkpoint-source-"));
  context.after(() => Promise.all([
    rm(rootDirectory, { recursive: true, force: true }),
    rm(sourceDirectory, { recursive: true, force: true })
  ]));
  await Promise.all([
    writeFile(path.join(sourceDirectory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "safe-checkpoint", base: "laya-multilingual" })),
    writeFile(path.join(sourceDirectory, "model.safetensors"), "safe fixture"),
    writeFile(path.join(sourceDirectory, "rl_agent_config.json"), "{}"),
    writeFile(path.join(sourceDirectory, "pytorch_model.bin"), "pickle fixture")
  ]);
  const training = createLayaTrainingManager({
    rootDirectory,
    datasetStore: { list: async () => [], exportJsonl: async () => "" }
  });
  await assert.rejects(training.importCheckpoint(sourceDirectory), /unsupported files: pytorch_model\.bin/i);
});

test("cancelled Laya runs can restart from a compatible rolling checkpoint", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-resume-"));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  await Promise.all([
    mkdir(path.join(rootDirectory, "training-runtime"), { recursive: true }),
    mkdir(path.join(rootDirectory, "models", "base-multilingual"), { recursive: true }),
    mkdir(path.join(rootDirectory, "training-runs", runId, "checkpoint_latest"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(rootDirectory, "training-runtime", "laya-trainer.exe"), "fixture"),
    writeFile(path.join(rootDirectory, "training-runs", runId, "dataset.jsonl"), "{}\n"),
    writeFile(path.join(rootDirectory, "training-runs", runId, "training-config.json"), "{}"),
    writeFile(path.join(rootDirectory, "training-runs", runId, "checkpoint_latest", "model.safetensors"), "fixture")
  ]);
  let arguments_;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit("exit", 1));
  const training = createLayaTrainingManager({
    rootDirectory,
    datasetStore: { list: async () => [], exportJsonl: async () => "" },
    spawnImplementation: (_executable, input) => { arguments_ = input; return child; }
  });
  const run = await training.start({ device: "cpu", resumeRunId: runId });
  assert.equal(run.id, runId);
  assert.ok(arguments_.includes("--resume"));
  const completion = training.waitForCompletion(runId);
  await training.cancel();
  await assert.rejects(completion, /cancelled/i);
  assert.equal((await training.status()).lastRun.status, "cancelled");
});
