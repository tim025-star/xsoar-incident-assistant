import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LAYA_MODEL } from "../src/laya-targets.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolveOptionalPath = (value) => value?.trim() ? path.resolve(value) : "";
const stageRoot = resolveOptionalPath(process.env.PILOT_STAGE_ROOT) || path.join(root, "release-stage", "laya-pilot");
const app = path.join(stageRoot, "XSOAR-Incident-Assistant-Laya-Pilot");
const artifacts = resolveOptionalPath(process.env.PILOT_ARTIFACTS_DIRECTORY) || path.join(root, "artifacts", "laya-pilot-release");
const modelSource = resolveOptionalPath(process.env.PILOT_MODEL_DIRECTORY);
const runtimeSource = resolveOptionalPath(process.env.PILOT_RUNTIME_DIRECTORY);
const nodeSource = resolveOptionalPath(process.env.NODE_RUNTIME_PATH);
const pilotPython = resolveOptionalPath(process.env.PILOT_PYTHON);
const execFileAsync = promisify(execFile);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? "unknown"}`)));
  });
}

async function requirePath(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  await access(value).catch(() => { throw new Error(`${label} was not found: ${value}`); });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", () => resolve(hash.digest("hex")));
  });
}

async function inventory(directory, base = directory) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await inventory(full, base));
    else if (entry.isFile()) {
      const info = await stat(full);
      rows.push({ path: path.relative(base, full).replaceAll("\\", "/"), size: info.size, sha256: await hashFile(full) });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function main() {
  const [{ stdout: sourceCommit }, { stdout: dirty }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: root })
  ]);
  if (dirty.trim()) throw new Error("Pilot packaging requires a clean committed worktree.");
  await Promise.all([
    requirePath(modelSource, "PILOT_MODEL_DIRECTORY"),
    requirePath(runtimeSource, "PILOT_RUNTIME_DIRECTORY"),
    requirePath(nodeSource, "NODE_RUNTIME_PATH"),
    requirePath(pilotPython, "PILOT_PYTHON")
  ]);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this script through npm so the locked dependency installer is available.");
  await run(process.execPath, [npmCli, "run", "build"]);
  await run(pilotPython, ["-m", "unittest", "test_export_pilot_snapshot.py"], { cwd: path.join(root, "laya-mapper") });
  await requirePath(path.join(root, "dist", "web", "index.html"), "freshly built web application");
  const modelManifest = JSON.parse(await readFile(path.join(modelSource, "manifest.json"), "utf8"));
  if (modelManifest.id !== LAYA_MODEL.id || modelManifest.revision !== LAYA_MODEL.revision
      || modelManifest.experimental !== true || modelManifest.diagnosticsOnly !== true
      || modelManifest.gate !== "pilotOnly" || modelManifest.snapshot !== true
      || modelManifest.trainingComplete !== false
      || modelManifest.promotionEligible !== false || modelManifest.metricsMatchWeights !== true
      || modelManifest.snapshotEpoch !== LAYA_MODEL.snapshotEpoch || modelManifest.metricsEpoch !== LAYA_MODEL.metricsEpoch
      || modelManifest.base?.revision !== LAYA_MODEL.baseRevision
      || modelManifest.sequenceMetrics?.sequenceAccuracy !== LAYA_MODEL.trainingSequenceAccuracy) {
    throw new Error("Pilot model manifest does not match the compiled experimental identity.");
  }
  if (await hashFile(path.join(modelSource, "model.safetensors")) !== LAYA_MODEL.revision) {
    throw new Error("Pilot model weights do not match the compiled experimental revision.");
  }
  await requirePath(path.join(runtimeSource, "laya-mapper.exe"), "packaged pilot runtime");
  const actualModelFiles = (await inventory(modelSource)).map((entry) => entry.path);
  const expectedModelFiles = [...Object.keys(modelManifest.inferenceFiles || {}), "manifest.json"]
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualModelFiles) !== JSON.stringify(expectedModelFiles)) {
    throw new Error("Pilot model directory contains missing or unreviewed extra files.");
  }

  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(app, { recursive: true });
  await Promise.all([
    mkdir(path.join(app, "scripts"), { recursive: true }),
    mkdir(path.join(app, "runtime"), { recursive: true }),
    mkdir(path.join(app, "laya-mapper", "models"), { recursive: true })
  ]);
  await Promise.all([
    cp(path.join(root, "src"), path.join(app, "src"), { recursive: true }),
    cp(path.join(root, "dist"), path.join(app, "dist"), { recursive: true }),
    cp(runtimeSource, path.join(app, "laya-mapper", "runtime-v2"), { recursive: true }),
    cp(modelSource, path.join(app, "laya-mapper", "models", LAYA_MODEL.id), { recursive: true }),
    copyFile(path.join(root, "scripts", "serve-laya-pilot.mjs"), path.join(app, "scripts", "serve-laya-pilot.mjs")),
    copyFile(path.join(root, "scripts", "smoke-laya-pilot.mjs"), path.join(app, "scripts", "smoke-laya-pilot.mjs")),
    copyFile(path.join(root, "package.json"), path.join(app, "package.json")),
    copyFile(path.join(root, "package-lock.json"), path.join(app, "package-lock.json")),
    copyFile(path.join(root, "LICENSE"), path.join(app, "LICENSE")),
    copyFile(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(app, "THIRD_PARTY_NOTICES.md")),
    copyFile(nodeSource, path.join(app, "runtime", "node.exe"))
  ]);
  let launcher = await readFile(path.join(root, "installer", "pilot-launcher.cmd"), "utf8");
  launcher = launcher.replaceAll("__PILOT_MODEL_ID__", LAYA_MODEL.id);
  await writeFile(path.join(app, "Start Experimental Laya Pilot.cmd"), launcher, "utf8");
  const readme = [
    "XSOAR Incident Assistant - Experimental Laya Pilot", "",
    "EXPERIMENTAL DIAGNOSTICS ONLY. Human review is required. This model has not passed release accuracy gates.", "",
    `Model: ${LAYA_MODEL.id}`, `Weights SHA-256: ${LAYA_MODEL.revision}`,
    `Snapshot epoch: ${modelManifest.snapshotEpoch}; reviewed training-sequence metric: ${(modelManifest.sequenceMetrics.sequenceAccuracy * 100).toFixed(2)}%.`,
    "That metric is teacher-forced accuracy on reviewed training sequences, not real-alert or production accuracy.", "",
    "1. Extract the entire ZIP to a local folder.",
    "2. Double-click Start Experimental Laya Pilot.cmd.",
    "3. Keep the console window open; your default browser opens the local diagnostics page.",
    "4. Paste only approved alert JSON, run the requested targets, and copy the full diagnostics for feedback.",
    "5. Press Ctrl+C in the console when finished.", "",
    "Verify the downloaded ZIP before extraction by comparing its release-page SHA-256 with:",
    `  Get-FileHash -Algorithm SHA256 .\\XSOAR-Incident-Assistant-${LAYA_MODEL.id}.zip`, "",
    "Nothing is installed, no alert or result is saved automatically, and the stable v0.3.14 installation is not changed.",
    "The runtime is CPU-only and offline. Unsigned executables may still be blocked by corporate AppLocker or SmartScreen.", ""
  ].join("\r\n");
  await writeFile(path.join(app, "README-FIRST.txt"), readme, "utf8");

  await run(process.execPath, [npmCli, "ci", "--omit=dev", "--ignore-scripts"], { cwd: app });
  await run(path.join(app, "runtime", "node.exe"), [path.join(app, "scripts", "smoke-laya-pilot.mjs"),
    path.join(app, "laya-mapper", "runtime-v2", "laya-mapper.exe"),
    path.join(app, "laya-mapper", "models", LAYA_MODEL.id)]);
  const files = await inventory(app);
  const bundleManifest = {
    schemaVersion: 1, kind: "experimental-laya-pilot-portable", createdAt: new Date().toISOString(),
    applicationVersion: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
    sourceCommit: sourceCommit.trim(),
    model: LAYA_MODEL, modelManifest, promotionEligible: false, files
  };
  await writeFile(path.join(app, "BUNDLE-MANIFEST.json"), JSON.stringify(bundleManifest, null, 2) + "\n", "utf8");

  await mkdir(artifacts, { recursive: true });
  const archive = path.join(artifacts, `XSOAR-Incident-Assistant-${LAYA_MODEL.id}.zip`);
  await rm(archive, { force: true });
  await run("tar.exe", ["-a", "-c", "-f", archive, "-C", stageRoot, path.basename(app)]);
  const extracted = path.join(root, "release-stage", "laya-pilot-archive-verification");
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await run("tar.exe", ["-x", "-f", archive, "-C", extracted]);
  const extractedApp = path.join(extracted, path.basename(app));
  await run(path.join(extractedApp, "runtime", "node.exe"), [path.join(extractedApp, "scripts", "smoke-laya-pilot.mjs"),
    path.join(extractedApp, "laya-mapper", "runtime-v2", "laya-mapper.exe"),
    path.join(extractedApp, "laya-mapper", "models", LAYA_MODEL.id)]);
  const sha256 = await hashFile(archive);
  await writeFile(archive + ".sha256", `${sha256}  ${path.basename(archive)}\r\n`, "utf8");
  console.log(JSON.stringify({ archive, size: (await stat(archive)).size, sha256 }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
