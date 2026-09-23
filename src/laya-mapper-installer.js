import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadVerifiedAsset, verifyAssetFile } from "./local-ai-installer.js";
import { createLayaSidecarRunner } from "./laya-worker.js";
import { LAYA_MODEL, LAYA_PROMPT_VERSION, LAYA_TARGET_CATALOGUE } from "./laya-targets.js";

const PROCESS_OUTPUT_LIMIT = 2 * 1024 * 1024;
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000;
function assertInstalledRuntimeIdentity(value) {
  if (value?.protocolVersion !== 2 || value?.model?.id !== LAYA_MODEL.id
      || value?.model?.revision !== LAYA_MODEL.revision || value?.model?.sdkVersion !== LAYA_MODEL.sdkVersion
      || value?.promptVersion !== LAYA_PROMPT_VERSION) {
    throw new Error("The installed Laya runtime/checkpoint identity does not match the pinned manifest and prompt contract.");
  }
}

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
  if (!value || value.schemaVersion !== 3 || value.protocolVersion !== 2 || value.layaVersion !== "0.3.5") {
    throw new Error("The Laya-mapper installation manifest is invalid.");
  }
  const runtime = validateArchive(value.runtime, "laya-mapper.exe");
  if (value.model?.id !== LAYA_MODEL.id || value.model?.repository !== LAYA_MODEL.repository || value.model?.revision !== LAYA_MODEL.revision) throw new Error("The English Laya model identity is invalid.");
  if (value.trainers !== undefined) throw new Error("The inference manifest must not contain trainer assets.");
  if (!Array.isArray(value.modelFiles) || !value.modelFiles.length) throw new Error("The Laya-mapper model manifest is empty.");
  const modelFiles = value.modelFiles.map((item) => {
    validateAsset(item);
    if (!/^[A-Za-z0-9._/-]+$/.test(item.path) || item.path.includes("..") || path.isAbsolute(item.path)) {
      throw new Error("The Laya-mapper model manifest contains an invalid path.");
    }
    return item;
  });
  if (new Set(modelFiles.map((item) => item.path.toLowerCase())).size !== modelFiles.length) throw new Error("Duplicate model file path.");
  return { schemaVersion: 3, protocolVersion: 2, model: LAYA_MODEL, layaVersion: value.layaVersion, runtime, modelFiles };
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
    if (!status.available) throw new Error("The installed Laya runtime did not pass its protocol check.");
    assertInstalledRuntimeIdentity(status);
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
    assertInstalledRuntimeIdentity(result.runtime);
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

export function createLayaMapperInstaller({
  manifest,
  rootDirectory = defaultRootDirectory(),
  fetchImplementation = globalThis.fetch,
  download = downloadVerifiedAsset,
  extract = extractLayaArchive,
  verifyInstallation = verifyLayaMapperInstallation,
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
  return {
    async installInference({ onProgress = () => {}, signal } = {}) {
      const total = manifest.runtime.size + manifest.modelFiles.reduce((sum, item) => sum + item.size, 0);
      let completed = 0;
      const progress = (status, assetCompleted) => onProgress({ status, completed: completed + assetCompleted, total });
      await installArchive(manifest.runtime, path.join(rootDirectory, "runtime-v2"), {
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
      await rm(cacheDirectory, { recursive: true, force: true });
      onProgress({ status: "Laya-mapper is installed.", completed: total, total });
      return { installed: true, checkpointId: manifest.model.id };
    }
  };
}
