import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, appendFile, mkdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createOllamaClient, DEFAULT_OLLAMA_MODEL } from "./local-ai.js";

const GITHUB_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com"
]);
const MAX_REDIRECTS = 5;
const PROCESS_OUTPUT_LIMIT = 64 * 1024;
const OLLAMA_START_TIMEOUT_MS = 30000;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30000;
const DOWNLOAD_STALL_TIMEOUT_MS = 120000;

export const LOCAL_AI_INSTALL_MANIFEST = Object.freeze({
  runner: Object.freeze({
    name: "OllamaSetup.exe",
    version: "0.34.0",
    url: "https://github.com/ollama/ollama/releases/download/v0.34.0/OllamaSetup.exe",
    size: 1574272976,
    sha256: "e2b98770fb87f3b4c593c22f2e8eda59bcac1cd7b141f1388c4181a8bf271a72"
  }),
  model: Object.freeze({
    name: DEFAULT_OLLAMA_MODEL,
    fileName: "qwen3.5-9b-q4_k_m.gguf",
    size: 6594462816,
    sha256: "dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c",
    parts: Object.freeze([
      Object.freeze({ name: "qwen3.5-9b-q4_k_m.gguf.part01", size: 1648615704, sha256: "6b2fbb3af29463c9cbba78ae6de4d878948ab2af3b1fa599bbd9f18c1478e0cc", url: "https://github.com/tim025-star/xsoar-incident-assistant/releases/download/model-qwen3.5-9b-q4km-v1/qwen3.5-9b-q4_k_m.gguf.part01" }),
      Object.freeze({ name: "qwen3.5-9b-q4_k_m.gguf.part02", size: 1648615704, sha256: "e95d949c86b4d1efc7fc3bc85d4ef88e2e7a761d0d15e5f5cf9c8413e26f2b8c", url: "https://github.com/tim025-star/xsoar-incident-assistant/releases/download/model-qwen3.5-9b-q4km-v1/qwen3.5-9b-q4_k_m.gguf.part02" }),
      Object.freeze({ name: "qwen3.5-9b-q4_k_m.gguf.part03", size: 1648615704, sha256: "36efc4b182a53779209fc45716fae82754b26a4731fd2e897040b34610a68da6", url: "https://github.com/tim025-star/xsoar-incident-assistant/releases/download/model-qwen3.5-9b-q4km-v1/qwen3.5-9b-q4_k_m.gguf.part03" }),
      Object.freeze({ name: "qwen3.5-9b-q4_k_m.gguf.part04", size: 1648615704, sha256: "072b2add80dd750f3fb9074b6d68013e09b2845ee8aeab475048098ea18a0a82", url: "https://github.com/tim025-star/xsoar-incident-assistant/releases/download/model-qwen3.5-9b-q4km-v1/qwen3.5-9b-q4_k_m.gguf.part04" })
    ])
  })
});

function defaultAppDataDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "XSOAR Incident Assistant");
}
function cleanLogText(value) { return String(value ?? "").replace(/[\r\n\u0000]+/g, " ").slice(0, 1000); }
function cancelledError() { return new Error("Local AI installation was cancelled."); }
function throwIfAborted(signal) { if (signal?.aborted) throw cancelledError(); }
async function fileExists(filePath) { try { await access(filePath); return true; } catch { return false; } }
async function fileSize(filePath) { try { return (await stat(filePath)).size; } catch { return -1; } }
async function delay(ms, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(cancelledError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function assertAllowedGitHubDownloadUrl(value, { initial = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("The local AI download returned an invalid URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("The local AI download was redirected outside GitHub.");
  }
  if (!GITHUB_DOWNLOAD_HOSTS.has(url.hostname) || (initial && url.hostname !== "github.com")) {
    throw new Error("The local AI download was redirected outside GitHub.");
  }
  if (initial && !url.pathname.includes("/releases/download/")) {
    throw new Error("The local AI download URL is not a GitHub Release asset.");
  }
  return url;
}

async function fetchGitHubAsset(fetchImplementation, asset, headers, signal) {
  let current = assertAllowedGitHubDownloadUrl(asset.url, { initial: true });
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    throwIfAborted(signal);
    const response = await fetchImplementation(current, { headers, redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) throw new Error(`GitHub did not serve ${asset.name}.`);
    current = assertAllowedGitHubDownloadUrl(new URL(location, current).href);
  }
  throw new Error(`GitHub redirected ${asset.name} too many times.`);
}

async function hashFile(filePath, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function isVerifiedFile(filePath, asset, signal) {
  if ((await fileSize(filePath)) !== asset.size) return false;
  return (await hashFile(filePath, signal)) === asset.sha256;
}

export async function downloadVerifiedAsset(asset, destination, {
  fetchImplementation = globalThis.fetch,
  onProgress = () => {},
  signal,
  connectTimeoutMs = DOWNLOAD_CONNECT_TIMEOUT_MS,
  stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS
} = {}) {
  if (typeof fetchImplementation !== "function") throw new Error("A fetch implementation is required for local AI installation.");
  await mkdir(path.dirname(destination), { recursive: true });
  if (await isVerifiedFile(destination, asset, signal)) {
    onProgress({ status: `Verified ${asset.name}.`, completed: asset.size, total: asset.size });
    return destination;
  }
  await rm(destination, { force: true });
  const partial = `${destination}.partial`;
  let offset = await fileSize(partial);
  if (offset < 0 || offset > asset.size) {
    await rm(partial, { force: true });
    offset = 0;
  }
  if (offset === asset.size) {
    if ((await hashFile(partial, signal)) === asset.sha256) {
      await rename(partial, destination);
      return destination;
    }
    await rm(partial, { force: true });
    offset = 0;
  }

  let response;
  const connectAbortController = new AbortController();
  const connectTimer = setTimeout(() => connectAbortController.abort(), connectTimeoutMs);
  const connectSignal = signal ? AbortSignal.any([signal, connectAbortController.signal]) : connectAbortController.signal;
  try {
    response = await fetchGitHubAsset(fetchImplementation, asset, offset ? { Range: `bytes=${offset}-` } : {}, connectSignal);
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    if (connectAbortController.signal.aborted) throw new Error(`GitHub did not connect while downloading ${asset.name}.`);
    if (error?.name === "AbortError") throw cancelledError();
    throw new Error(`GitHub could not download ${asset.name}.`);
  } finally { clearTimeout(connectTimer); }
  if (offset && response.status === 200) {
    offset = 0;
    await rm(partial, { force: true });
  } else if (offset && response.status === 206) {
    const contentRange = response.headers.get("content-range") || "";
    if (!contentRange.startsWith(`bytes ${offset}-`)) throw new Error(`GitHub returned an invalid resumed download for ${asset.name}.`);
  } else if (response.status !== 200) {
    throw new Error(`GitHub could not download ${asset.name} (${response.status}).`);
  }
  if (!response.body) throw new Error(`GitHub returned an empty download for ${asset.name}.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > asset.size - offset) throw new Error(`GitHub returned an oversized download for ${asset.name}.`);

  const hash = createHash("sha256");
  if (offset) {
    for await (const chunk of createReadStream(partial)) { throwIfAborted(signal); hash.update(chunk); }
  }
  let completed = offset;
  const stallAbortController = new AbortController();
  let stallTimer;
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stallAbortController.abort(), stallTimeoutMs);
  };
  resetStallTimer();
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      resetStallTimer();
      completed += chunk.length;
      if (completed > asset.size) return callback(new Error(`GitHub returned an oversized download for ${asset.name}.`));
      hash.update(chunk);
      onProgress({ status: `Downloading ${asset.name}.`, completed, total: asset.size });
      callback(null, chunk);
    }
  });
  try {
    const streamSignal = signal ? AbortSignal.any([signal, stallAbortController.signal]) : stallAbortController.signal;
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: offset ? "a" : "w" }), { signal: streamSignal });
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    if (stallAbortController.signal.aborted) throw new Error(`GitHub download stalled while receiving ${asset.name}.`);
    if (error?.name === "AbortError") throw cancelledError();
    throw error;
  } finally { clearTimeout(stallTimer); }
  if (completed !== asset.size) throw new Error(`GitHub returned an incomplete download for ${asset.name}.`);
  if (hash.digest("hex") !== asset.sha256) {
    await rm(partial, { force: true });
    throw new Error(`The SHA-256 checksum for ${asset.name} did not match.`);
  }
  await rename(partial, destination);
  return destination;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function locateOllamaExecutable() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Ollama", "ollama.exe"),
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, "ollama.exe"))
  ].filter(Boolean);
  for (const candidate of candidates) if (await fileExists(candidate)) return candidate;
  return undefined;
}

function runProcess(executable, arguments_, { cwd, inherit = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, arguments_, {
      cwd,
      windowsHide: !inherit,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      signal
    });
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk).slice(-PROCESS_OUTPUT_LIMIT); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-PROCESS_OUTPUT_LIMIT); });
    child.once("error", (error) => signal?.aborted ? reject(cancelledError()) : reject(error));
    child.once("exit", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = cleanLogText(stderr || stdout);
      reject(new Error(`${path.basename(executable)} exited with code ${code ?? "unknown"}.${detail ? ` ${detail}` : ""}`));
    });
  });
}

function startOllamaServer(executable) {
  const child = spawn(executable, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => {});
  child.unref();
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

async function assembleModel(model, cacheDirectory, download, onProgress, signal) {
  const finalPath = path.join(cacheDirectory, model.fileName);
  if (await isVerifiedFile(finalPath, model, signal)) return finalPath;
  await rm(finalPath, { force: true });
  const partialPath = `${finalPath}.partial`;
  const statePath = path.join(cacheDirectory, "assembly.json");
  let completedParts = 0;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.sha256 === model.sha256 && Number.isInteger(state.completedParts)) completedParts = state.completedParts;
  } catch {}
  if (completedParts < 0 || completedParts > model.parts.length) completedParts = 0;
  const expectedPrefixSize = model.parts.slice(0, completedParts).reduce((total, part) => total + part.size, 0);
  if ((await fileSize(partialPath)) !== expectedPrefixSize) {
    if (expectedPrefixSize === 0) await rm(partialPath, { force: true });
    else if ((await fileSize(partialPath)) > expectedPrefixSize) await truncate(partialPath, expectedPrefixSize);
    else { await rm(partialPath, { force: true }); completedParts = 0; }
  }
  const downloadsDirectory = path.join(cacheDirectory, "downloads");
  await mkdir(downloadsDirectory, { recursive: true });
  for (let index = completedParts; index < model.parts.length; index += 1) {
    throwIfAborted(signal);
    const part = model.parts[index];
    const previousBytes = model.parts.slice(0, index).reduce((total, item) => total + item.size, 0);
    const partPath = path.join(downloadsDirectory, part.name);
    await download(part, partPath, {
      signal,
      onProgress: ({ completed }) => onProgress({
        status: `Downloading default model part ${index + 1} of ${model.parts.length}.`,
        completed: previousBytes + completed,
        total: model.size
      })
    });
    onProgress({ status: `Assembling default model part ${index + 1} of ${model.parts.length}.`, completed: previousBytes, total: model.size });
    try {
      await pipeline(createReadStream(partPath), createWriteStream(partialPath, { flags: "a" }), { signal });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw cancelledError();
      throw error;
    }
    await rm(partPath, { force: true });
    completedParts = index + 1;
    await writeJsonAtomic(statePath, { sha256: model.sha256, completedParts });
  }
  onProgress({ status: "Verifying the assembled default model.", completed: model.size, total: model.size });
  if (!(await isVerifiedFile(partialPath, model, signal))) {
    await rm(partialPath, { force: true });
    await rm(statePath, { force: true });
    throw new Error("The assembled default model checksum did not match.");
  }
  await rename(partialPath, finalPath);
  await rm(statePath, { force: true });
  return finalPath;
}

export function createLocalAiInstaller({
  localAi = createOllamaClient(),
  manifest = LOCAL_AI_INSTALL_MANIFEST,
  appDataDirectory = defaultAppDataDirectory(),
  fetchImplementation = globalThis.fetch,
  locateOllama = locateOllamaExecutable,
  runExecutable = runProcess,
  startServer = startOllamaServer,
  download = downloadVerifiedAsset
} = {}) {
  const cacheDirectory = path.join(appDataDirectory, "local-ai-install");
  const logPath = path.join(appDataDirectory, "logs", "local-ai-install.log");
  const log = async (message) => {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${new Date().toISOString()} ${cleanLogText(message)}\n`, { encoding: "utf8" });
  };
  const waitForOllama = async (signal) => {
    const deadline = Date.now() + OLLAMA_START_TIMEOUT_MS;
    do {
      const status = await localAi.status();
      if (status.available) return;
      await delay(500, signal);
    } while (Date.now() < deadline);
    throw new Error("Ollama was installed but its local service did not start.");
  };
  const ensureOllama = async (onProgress, signal) => {
    const readVersion = async (executable) => {
      let output;
      try { output = await runExecutable(executable, ["--version"]); }
      catch { throw new Error("The installed Ollama version could not be determined."); }
      const version = `${output.stdout} ${output.stderr}`.match(/(\d+\.\d+\.\d+)/)?.[1];
      if (!version) throw new Error("The installed Ollama version could not be determined.");
      return version;
    };
    let executable = await locateOllama();
    let version = executable ? await readVersion(executable) : undefined;
    if (!executable || compareVersions(version, manifest.runner.version) < 0) {
      onProgress({ status: `Downloading Ollama ${manifest.runner.version} from GitHub.`, completed: 0, total: manifest.runner.size });
      const setupPath = await download(manifest.runner, path.join(cacheDirectory, "runner", manifest.runner.name), { fetchImplementation, onProgress, signal });
      await log(`Launching verified Ollama ${manifest.runner.version} installer.`);
      onProgress({ status: "Complete the Ollama installer window to continue.", completed: manifest.runner.size, total: manifest.runner.size });
      await runExecutable(setupPath, [], { inherit: true });
      executable = await locateOllama();
      if (!executable) throw new Error("Ollama installation finished, but ollama.exe was not found.");
      version = await readVersion(executable);
      if (compareVersions(version, manifest.runner.version) < 0) throw new Error(`Ollama ${manifest.runner.version} or newer is required.`);
      await rm(setupPath, { force: true });
    }
    const status = await localAi.status();
    if (!status.available) {
      await log("Starting the loopback Ollama service.");
      startServer(executable);
      await waitForOllama(signal);
    }
    return executable;
  };

  const withInstallLog = async (model, action) => {
    await mkdir(cacheDirectory, { recursive: true });
    await log(`Starting local AI installation for ${model}.`);
    try { return await action(); } catch (error) {
      await log(`Installation failed: ${error instanceof Error ? error.message : error}`);
      const detail = error instanceof Error ? error.message : "Local AI installation failed.";
      throw new Error(`${detail} See ${logPath} for details.`);
    }
  };
  const installDefaultModel = async ({ onProgress = () => {}, signal } = {}) => withInstallLog(manifest.model.name, async () => {
    const executable = await ensureOllama(onProgress, signal);
    const status = await localAi.status();
    if (status.models.includes(manifest.model.name)) {
      const models = await localAi.pull(manifest.model.name, { signal });
      await log(`${manifest.model.name} is already installed locally.`);
      onProgress({ status: `${manifest.model.name} is already installed locally.`, completed: 1, total: 1 });
      return models;
    }
    const modelPath = await assembleModel(
      manifest.model,
      cacheDirectory,
      (asset, destination, options) => download(asset, destination, { ...options, fetchImplementation }),
      onProgress,
      signal
    );
    const modelfilePath = path.join(cacheDirectory, "Modelfile");
    await writeFile(modelfilePath, `FROM ./${manifest.model.fileName}\n`, { encoding: "utf8", mode: 0o600 });
    onProgress({ status: `Importing ${manifest.model.name} into Ollama.`, completed: manifest.model.size, total: manifest.model.size });
    await runExecutable(executable, ["create", manifest.model.name, "-f", modelfilePath], { cwd: cacheDirectory, signal });
    const models = await localAi.pull(manifest.model.name, { signal });
    await Promise.all([
      rm(modelPath, { force: true }),
      rm(modelfilePath, { force: true }),
      rm(path.join(cacheDirectory, "downloads"), { recursive: true, force: true })
    ]);
    await log(`Installed and verified ${manifest.model.name}.`);
    return models;
  });
  return {
    logPath,
    installDefaultModel,
    async installModel(model, { onProgress = () => {}, signal } = {}) {
      if (model === manifest.model.name) return installDefaultModel({ onProgress, signal });
      return withInstallLog(model, async () => {
        await ensureOllama(onProgress, signal);
        const models = await localAi.pull(model, { onProgress, signal });
        await log(`Installed and verified ${model}.`);
        return models;
      });
    }
  };
}
