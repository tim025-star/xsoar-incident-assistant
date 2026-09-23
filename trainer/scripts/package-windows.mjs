import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const trainerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDirectory = path.resolve(trainerDirectory, "..");
const stageDirectory = path.join(trainerDirectory, "release-stage");
const applicationDirectory = path.join(stageDirectory, "app");
const outputDirectory = path.join(rootDirectory, "artifacts", "trainer");
const runtimeDirectory = path.resolve(process.env.TRAINER_RUNTIME_DIRECTORY || "");
const backend = String(process.env.TRAINER_BACKEND || "cpu").toLowerCase();

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: rootDirectory, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? "unknown"}.`)));
  });
}

async function requireFile(filePath, description) {
  try { await access(filePath, constants.R_OK); }
  catch { throw new Error(`${description} was not found: ${filePath}`); }
}

function isccPath() {
  if (process.env.ISCC_PATH) return process.env.ISCC_PATH;
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe")
  ];
  return candidates.find(existsSync) || candidates[0];
}

function appVersion() {
  const version = String(process.env.APP_VERSION || process.env.npm_package_version || "0.0.0").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`APP_VERSION must be semantic: ${version}`);
  return version;
}

async function stageRelease() {
  if (!new Set(["cpu", "cuda"]).has(backend)) throw new Error("TRAINER_BACKEND must be cpu or cuda.");
  if (!process.env.TRAINER_RUNTIME_DIRECTORY) throw new Error("TRAINER_RUNTIME_DIRECTORY must name the packaged trainer runtime directory.");
  await requireFile(path.join(runtimeDirectory, "laya-developer-trainer.exe"), "Packaged Laya trainer runtime");
  const status = JSON.parse((await new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn(path.join(runtimeDirectory, "laya-developer-trainer.exe"), ["runtime-status", "--device", backend], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error("The trainer runtime identity check failed.")));
  })).trim());
  if (status.laya !== "0.3.5" || status.transformers !== "4.57.6" || status.safetensors !== "0.6.2"
      || Boolean(status.cuda) !== (backend === "cuda")) {
    throw new Error("The trainer runtime does not match the pinned dependencies and selected backend.");
  }

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(applicationDirectory, { recursive: true });
  await cp(runtimeDirectory, path.join(applicationDirectory, "runtime"), { recursive: true });
  await mkdir(path.join(applicationDirectory, "config"), { recursive: true });
  await mkdir(path.join(applicationDirectory, "docs"), { recursive: true });
  await Promise.all([
    copyFile(path.join(trainerDirectory, "python", "base-model-manifest.json"), path.join(applicationDirectory, "config", "base-model-manifest.json")),
    copyFile(path.join(trainerDirectory, "python", "developer-training-config.json"), path.join(applicationDirectory, "config", "developer-training-config.json")),
    copyFile(path.join(trainerDirectory, "python", "source-record.schema.json"), path.join(applicationDirectory, "config", "source-record.schema.json")),
    copyFile(path.join(trainerDirectory, "docs", "training-pipeline.md"), path.join(applicationDirectory, "docs", "training-pipeline.md")),
    copyFile(path.join(trainerDirectory, "README.md"), path.join(applicationDirectory, "README.md")),
    copyFile(path.join(trainerDirectory, "installer", "launch-console.cmd"), path.join(applicationDirectory, "Laya Trainer Console.cmd")),
    copyFile(path.join(rootDirectory, "LICENSE"), path.join(applicationDirectory, "LICENSE")),
    copyFile(path.join(rootDirectory, "THIRD_PARTY_NOTICES.md"), path.join(applicationDirectory, "THIRD_PARTY_NOTICES.md"))
  ]);
  await writeFile(path.join(applicationDirectory, "trainer-install.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "xsoar-laya-trainer",
    backend,
    version: appVersion(),
    layaVersion: status.laya,
    transformersVersion: status.transformers,
    safetensorsVersion: status.safetensors
  }, null, 2)}\n`, "utf8");
  const installedReadme = await readFile(path.join(applicationDirectory, "README.md"), "utf8");
  if (!installedReadme.includes("does not install or modify the XSOAR Incident Assistant")) throw new Error("Trainer package separation notice is missing.");
}

async function main() {
  await stageRelease();
  const compiler = isccPath();
  await requireFile(compiler, "Inno Setup compiler");
  await mkdir(outputDirectory, { recursive: true });
  await run(compiler, [
    "/Qp",
    `/DAppVersion=${appVersion()}`,
    `/DTrainerBackend=${backend}`,
    `/DStageDir=${applicationDirectory}`,
    `/O${outputDirectory}`,
    path.join(trainerDirectory, "installer", "LayaTrainer.iss")
  ]);
  const installerName = `XSOAR-Laya-Trainer-Setup-${appVersion()}-${backend}-x64.exe`;
  const installerPath = path.join(outputDirectory, installerName);
  const digest = createHash("sha256").update(await readFile(installerPath)).digest("hex");
  await writeFile(`${installerPath}.sha256`, `${digest} *${installerName}`, "utf8");
}

main().catch((error) => {
  console.error(`Laya trainer Windows packaging failed: ${error.message}`);
  process.exitCode = 1;
});
