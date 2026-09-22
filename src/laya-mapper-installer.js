import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadVerifiedAsset, verifyAssetFile } from "./local-ai-installer.js";
import { createLayaSidecarRunner } from "./laya-worker.js";
import { LAYA_MODEL, LAYA_TARGET_CATALOGUE } from "./laya-targets.js";

const PROCESS_OUTPUT_LIMIT = 2 * 1024 * 1024;
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000;

function defaultRootDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "XSOAR Incident Assistant", "laya-mapper");
}

function validateAsset(asset) {
  if (!asset || typeof asset !== "object" || typeof asset.name !== "string"
    || typeof asset.url !== "string" || !Number.isInteger(asset.size) || asset.size < 1
    || !/^[a-f0-9]{64}$/.test(asset.sha256 || "")) throw new Error("The Laya-mapper installation manifest is invalid.");
  if (!/^[A-Za-z0-9._-]+$/.test(asset.name) || asset.name === "." || asset.name === "..") {
    throw new Error("The Laya-mapper installation manifest contains an invalid asset name.");
  }
  const url = new URL(asset.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.includes("/releases/download/")) {
    throw new Error("Laya-mapper assets must use verified GitHub release URLs.");
  }
  return asset;
}

function validateArchive(asset, expectedEntry) {
  validateAsset(asset);
  if (!asset.name.endsWith(".tar.gz") || asset.entry !== expectedEntry) {
    throw new Error("The Laya-mapper archive manifest is invalid.");
  }
  return asset;
}

export function parseLayaInstallManifest(value) {
  if (!value || ![2, 3].includes(value.schemaVersion) || value.layaVersion !== "0.3.5") {
    throw new Error("The Laya-mapper installation manifest is invalid.");
  }
  const runtime = validateArchive(value.runtime, "laya-mapper.exe");
  const baseline = value.schemaVersion === 3;
  if (baseline && (value.protocolVersion !== 2 || value.model?.id !== LAYA_MODEL.id || value.model?.repository !== LAYA_MODEL.repository || value.model?.revision !== LAYA_MODEL.revision)) throw new Error("The English Laya model identity is invalid.");
  const trainers = baseline ? {} : {
    cpu: validateArchive(value.trainers?.cpu, "laya-trainer.exe"),
    cuda: validateArchive(value.trainers?.cuda, "laya-trainer.exe")
  };
  if (!Array.isArray(value.modelFiles) || !value.modelFiles.length) throw new Error("The Laya-mapper model manifest is empty.");
  const modelFiles = value.modelFiles.map((item) => {
    validateAsset(item);
    if (!/^[A-Za-z0-9._/-]+$/.test(item.path) || item.path.includes("..") || path.isAbsolute(item.path)) {
      throw new Error("The Laya-mapper model manifest contains an invalid path.");
    }
    return item;
  });
  if (new Set(modelFiles.map((item) => item.path.toLowerCase())).size !== modelFiles.length) throw new Error("Duplicate model file path.");
  return { schemaVersion: value.schemaVersion, protocolVersion: baseline ? 2 : 1, model: baseline ? LAYA_MODEL : { id: "base-multilingual" }, layaVersion: value.layaVersion, runtime, trainers, modelFiles };
}

export async function loadLayaInstallManifest(filePath) {
  return parseLayaInstallManifest(JSON.parse(await readFile(filePath, "utf8")));
}

export async function verifyLayaMapperInstallation({ rootDirectory = defaultRootDirectory(), runnerFactory = createLayaSidecarRunner } = {}) {
  const runner = runnerFactory({
    executable: path.join(rootDirectory, "runtime-v2", "laya-mapper.exe"),
    threads: 1,
    env: { LAYA_MAPPER_ROOT: rootDirectory }
  });
  try {
    const status = await runner.status();
    if (!status.available || status.protocolVersion !== 2) throw new Error("The installed Laya runtime did not pass its protocol check.");
    const result = await runner.evaluate({ decisions: [{
      id: "install-smoke",
      kind: "classify",
      target: { id: "sourceIp", ...LAYA_TARGET_CATALOGUE.sourceIp },
      field: { id: "f0", key: "sourceIp", ancestry: ["documents", "0"], value: "203.0.113.8" }
    }] });
    const answer = result?.results?.[0];
    if (answer?.id !== "install-smoke" || !Number.isFinite(answer.score) || result?.runtime?.ready !== true) {
      throw new Error("The installed Laya runtime did not pass its inference check.");
    }
    return { protocolVersion: status.protocolVersion, model: status.model, promptVersion: status.promptVersion };
  } finally {
    runner.close();
  }
}

function runProcess(executable, arguments_, { spawnImplementation = spawn, timeoutMs = EXTRACTION_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(executable, arguments_, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("The Laya runtime archive operation timed out."));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > PROCESS_OUTPUT_LIMIT) {
        child.kill();
        finish(reject, new Error("The Laya runtime archive listing was too large."));
      }
    });
    child.once("error", () => finish(reject, new Error("Windows tar.exe is required to install Laya-mapper.")));
    child.once("exit", (code) => finish(
      code === 0 ? resolve : reject,
      code === 0 ? { stdout } : new Error("Windows could not extract the verified Laya runtime archive.")
    ));
  });
}

function validateArchiveEntries(output) {
  const entries = output.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.length > 20000) throw new Error("The Laya runtime archive has an invalid file listing.");
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized && /^\.\/?$/.test(entry)) continue;
    const parts = normalized.split("/").filter(Boolean);
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
      || parts.includes("..") || normalized.includes("\0")) {
      throw new Error("The Laya runtime archive contains an unsafe path.");
    }
  }
}

export async function extractLayaArchive(archivePath, destination, expectedEntry, { spawnImplementation = spawn } = {}) {
  const listing = await runProcess("tar.exe", ["-tzf", archivePath], { spawnImplementation });
  validateArchiveEntries(listing.stdout);
  const staging = `${destination}.${process.pid}.staging`;
  const backup = `${destination}.${process.pid}.backup`;
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await runProcess("tar.exe", ["-xzf", archivePath, "-C", staging], { spawnImplementation });
    await access(path.join(staging, expectedEntry)).catch(() => { throw new Error("The Laya runtime archive is missing its entry point."); });
    let movedExisting = false;
    try {
      await rename(destination, backup);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (movedExisting) await rename(backup, destination).catch(() => {});
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function detectNvidiaTrainingBackend({ spawnImplementation = spawn, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawnImplementation("nvidia-smi.exe", ["--query-gpu=name", "--format=csv,noheader"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => { child.kill(); finish("cpu"); }, timeoutMs);
    child.once("error", () => finish("cpu"));
    child.once("exit", (code) => finish(code === 0 ? "cuda" : "cpu"));
  });
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export function createLayaMapperInstaller({
  manifest,
  rootDirectory = defaultRootDirectory(),
  fetchImplementation = globalThis.fetch,
  download = downloadVerifiedAsset,
  extract = extractLayaArchive,
  verifyInstallation = verifyLayaMapperInstallation,
  detectTrainingBackend = detectNvidiaTrainingBackend,
  offlineDirectories = []
} = {}) {
  manifest = parseLayaInstallManifest(manifest);
  const cacheDirectory = path.join(rootDirectory, "install-cache");
  const candidateDirectories = [...new Set([
    ...offlineDirectories.filter(Boolean).map((item) => path.resolve(item)),
    path.join(rootDirectory, "offline-assets")
  ])];
  const obtainAsset = async (asset, options) => {
    const cached = path.join(cacheDirectory, asset.name);
    await mkdir(cacheDirectory, { recursive: true });
    for (const directory of candidateDirectories) {
      const candidate = path.join(directory, asset.name);
      if (await verifyAssetFile(candidate, asset, options?.signal)) {
        await copyFile(candidate, cached);
        options?.onProgress?.({ status: `Verified offline ${asset.name}.`, completed: asset.size, total: asset.size });
        return cached;
      }
    }
    await download(asset, cached, { ...options, fetchImplementation });
    return cached;
  };
  const installFile = async (asset, destination, options) => {
    const cached = await obtainAsset(asset, options);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    await copyFile(cached, temporary);
    await rm(destination, { force: true });
    await rename(temporary, destination);
  };
  const installArchive = async (asset, destination, options) => {
    const cached = await obtainAsset(asset, options);
    await extract(cached, destination, asset.entry);
  };
  const preserveOfflineTrainingAssets = async ({ signal, onProgress }) => {
    const offlineCache = path.join(rootDirectory, "offline-assets");
    for (const asset of Object.values(manifest.trainers)) {
      for (const directory of candidateDirectories) {
        const candidate = path.join(directory, asset.name);
        if (path.resolve(candidate) === path.resolve(path.join(offlineCache, asset.name))) break;
        if (!await verifyAssetFile(candidate, asset, signal)) continue;
        await mkdir(offlineCache, { recursive: true });
        const temporary = path.join(offlineCache, `${asset.name}.${process.pid}.tmp`);
        await copyFile(candidate, temporary);
        await rm(path.join(offlineCache, asset.name), { force: true });
        await rename(temporary, path.join(offlineCache, asset.name));
        onProgress({
          status: `Saved verified offline ${asset.name} for later fine-tuning.`,
          completed: asset.size,
          total: asset.size
        });
        break;
      }
    }
  };
  return {
    async installInference({ onProgress = () => {}, signal } = {}) {
      const total = manifest.runtime.size + manifest.modelFiles.reduce((sum, item) => sum + item.size, 0);
      let completed = 0;
      const progress = (status, assetCompleted) => onProgress({ status, completed: completed + assetCompleted, total });
      await installArchive(manifest.runtime, path.join(rootDirectory, manifest.protocolVersion === 2 ? "runtime-v2" : "runtime"), {
        signal,
        onProgress: ({ completed: value }) => progress(`Installing Laya-mapper ${manifest.runtime.name}.`, value)
      });
      completed += manifest.runtime.size;
      for (const asset of manifest.modelFiles) {
        await installFile(asset, path.join(rootDirectory, "models", manifest.model.id, ...asset.path.split("/")), {
          signal,
          onProgress: ({ completed: value }) => progress(`Installing Laya-mapper ${asset.name}.`, value)
        });
        completed += asset.size;
      }
      onProgress({ status: "Verifying the installed Laya runtime and checkpoint.", completed: total, total });
      await verifyInstallation({ rootDirectory });
      await preserveOfflineTrainingAssets({ signal, onProgress });
      await rm(cacheDirectory, { recursive: true, force: true });
      onProgress({ status: "Laya-mapper is installed.", completed: total, total });
      return { installed: true, checkpointId: manifest.model.id };
    },
    async installTrainingTools({ backend = "auto", onProgress = () => {}, signal } = {}) {
      const selectedBackend = backend === "auto" ? await detectTrainingBackend() : backend;
      if (!Object.hasOwn(manifest.trainers, selectedBackend)) throw new Error("The selected Laya training backend is unavailable.");
      const asset = manifest.trainers[selectedBackend];
      await installArchive(asset, path.join(rootDirectory, "training-runtime"), {
        signal,
        onProgress: ({ completed, total }) => onProgress({
          status: `Installing Laya ${selectedBackend.toUpperCase()} fine-tuning tools.`, completed, total
        })
      });
      await rm(cacheDirectory, { recursive: true, force: true });
      await atomicJson(path.join(rootDirectory, "training-runtime", "install.json"), {
        schemaVersion: 1,
        backend: selectedBackend,
        installedAt: new Date().toISOString()
      });
      return { installed: true, backend: selectedBackend };
    }
  };
}
