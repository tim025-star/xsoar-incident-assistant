import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createLayaMapperInstaller, extractLayaArchive, parseLayaInstallManifest, verifyLayaMapperInstallation } from "../src/laya-mapper-installer.js";
import { LAYA_MODEL } from "../src/laya-targets.js";

const digest = "a".repeat(64);
const asset = (name, size = 4) => ({
  name,
  size,
  sha256: digest,
  url: `https://github.com/example/laya-assets/releases/download/v1/${name}`
});
const checkpoint = {
  id: "expanded-training-cuda-632-alerts-v1",
  label: "Reviewed 632-alert Laya demo",
  channel: "demo",
  weightsSha256: digest,
  trainingComplete: true,
  promotionEligible: false,
  trainingSequences: 23512,
  developmentSequences: 5338,
  sequenceAccuracy: 0.8115399025852379,
  warning: "Review every mapping."
};
const manifest = {
  schemaVersion: 4,
  protocolVersion: 2,
  model: LAYA_MODEL,
  checkpoint,
  layaVersion: "0.3.5",
  runtime: { ...asset("laya-mapper-runtime-cpu-x64.tar.gz"), entry: "laya-mapper.exe" },
  modelFiles: [{ ...asset("model.safetensors"), path: "model.safetensors" }]
};

test("demo inference manifest pins the base identity and trained checkpoint weights", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-english-install-"));
  context.after(() => rm(rootDirectory, { recursive: true, force: true }));
  assert.equal(parseLayaInstallManifest(manifest).checkpoint.id, checkpoint.id);
  assert.throws(() => parseLayaInstallManifest({ ...manifest, schemaVersion: 2 }), /invalid/);
  assert.throws(() => parseLayaInstallManifest({ ...manifest, trainers: { cpu: {} } }), /must not contain trainer assets/);
  assert.throws(() => parseLayaInstallManifest({ ...manifest, model: { ...LAYA_MODEL, revision: "wrong" } }), /identity/);
  assert.throws(() => parseLayaInstallManifest({ ...manifest, checkpoint: { ...checkpoint, weightsSha256: "b".repeat(64) } }), /does not match.*weights/i);
  const destinations = [];
  const installer = createLayaMapperInstaller({ manifest, rootDirectory,
    download: async (asset, destination) => { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, Buffer.alloc(asset.size)); },
    extract: async (_, destination) => { destinations.push(destination); },
    verifyInstallation: async ({ rootDirectory: verifiedRoot }) => { assert.equal(verifiedRoot, rootDirectory); }
  });
  assert.deepEqual(await installer.installInference(), { installed: true, checkpointId: checkpoint.id });
  assert.deepEqual(destinations, [path.join(rootDirectory, "runtime-v2")]);
  await access(path.join(rootDirectory, "models/base-english/model.safetensors"));
  assert.equal(JSON.parse(await readFile(path.join(rootDirectory, "install.json"), "utf8")).checkpoint.id, checkpoint.id);
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
    verifyInstallation: async () => {}
  });
  assert.deepEqual(await installer.installInference(), { installed: true, checkpointId: checkpoint.id });
  assert.deepEqual(downloaded, ["laya-mapper-runtime-cpu-x64.tar.gz", "model.safetensors"]);
  assert.throws(() => parseLayaInstallManifest({
    ...manifest,
    runtime: { ...manifest.runtime, name: "../outside.exe" }
  }), /invalid asset name/i);
  assert.throws(() => parseLayaInstallManifest({
    ...manifest,
    runtime: { ...manifest.runtime, url: "https://example.com/laya-mapper.exe" }
  }), /GitHub release URLs/i);
});

test("Laya inference installation works from an offline asset pack", async (context) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-offline-install-"));
  const offlineDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-offline-assets-"));
  context.after(() => Promise.all([
    rm(rootDirectory, { recursive: true, force: true }),
    rm(offlineDirectory, { recursive: true, force: true })
  ]));
  const contents = Buffer.from("test");
  const offlineManifest = JSON.parse(JSON.stringify(manifest));
  const checksum = createHash("sha256").update(contents).digest("hex");
  for (const item of [offlineManifest.runtime, ...offlineManifest.modelFiles]) {
    item.size = contents.length;
    item.sha256 = checksum;
    await writeFile(path.join(offlineDirectory, item.name), contents);
  }
  offlineManifest.checkpoint.weightsSha256 = checksum;
  const installer = createLayaMapperInstaller({
    manifest: offlineManifest,
    rootDirectory,
    offlineDirectories: [offlineDirectory],
    download: async () => { throw new Error("network download was not expected"); },
    extract: async (_archive, destination, entry) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, entry), "fixture");
    },
    verifyInstallation: async () => {}
  });
  await installer.installInference();
});

test("installed Laya verification requires a protocol-2 status and real inference response", async () => {
  const calls = [];
  const result = await verifyLayaMapperInstallation({
    rootDirectory: "C:\\Laya Test",
    runnerFactory: (options) => ({
      status: async () => ({ available: true, protocolVersion: 2, model: LAYA_MODEL, promptVersion: "english-fields-v3" }),
      evaluate: async (input) => {
        calls.push({ options, input });
        return { results: [{ id: "install-smoke", score: 0.75 }], runtime: {
          ready: true, protocolVersion: 2, model: LAYA_MODEL, promptVersion: "english-fields-v3"
        } };
      },
      close: () => { calls.push("closed"); }
    })
  });
  assert.equal(result.protocolVersion, 2);
  assert.equal(calls[0].options.env.LAYA_MAPPER_ROOT, "C:\\Laya Test");
  assert.equal(calls[0].input.decisions[0].field.value, "203.0.113.8");
  assert.equal(calls.at(-1), "closed");
});

test("installed Laya verification rejects stale checkpoint and prompt identities", async () => {
  for (const mutation of [
    (status) => ({ ...status, model: { ...status.model, revision: "stale-revision" } }),
    (status) => ({ ...status, promptVersion: "english-fields-v2" })
  ]) {
    const expected = { available: true, protocolVersion: 2, model: LAYA_MODEL, promptVersion: "english-fields-v3" };
    await assert.rejects(verifyLayaMapperInstallation({
      rootDirectory: "C:\\Laya Test",
      runnerFactory: () => ({ status: async () => mutation(expected), evaluate: async () => { throw new Error("must not infer"); }, close() {} })
    }), /identity.*pinned manifest/i);
  }
  const expected = { available: true, protocolVersion: 2, model: LAYA_MODEL, promptVersion: "english-fields-v3" };
  await assert.rejects(verifyLayaMapperInstallation({
    rootDirectory: "C:\\Laya Test",
    runnerFactory: () => ({
      status: async () => expected,
      evaluate: async () => ({ results: [{ id: "install-smoke", score: 0.75 }], runtime: {
        ready: true, ...expected, model: { ...LAYA_MODEL, id: "wrong-checkpoint" }
      } }),
      close() {}
    })
  }), /identity.*pinned manifest/i);
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
