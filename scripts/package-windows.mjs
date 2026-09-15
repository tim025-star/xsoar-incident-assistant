import { access, cp, mkdir, rm, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageDirectory = path.join(rootDirectory, "release-stage");
const applicationDirectory = path.join(stageDirectory, "app");
const outputDirectory = path.join(rootDirectory, "artifacts");
const nodeRuntimePath = process.env.NODE_RUNTIME_PATH;

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: rootDirectory, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function requireFile(filePath, description) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`${description} was not found: ${filePath}`);
  }
}

function isccPath() {
  if (process.env.ISCC_PATH) return process.env.ISCC_PATH;
  return path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe");
}

function appVersion() {
  const version = String(process.env.APP_VERSION || process.env.npm_package_version || "0.0.0").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`APP_VERSION must be a semantic version, optionally prefixed with v: ${version}`);
  }
  return version;
}

async function stageRelease() {
  if (!nodeRuntimePath) {
    throw new Error("NODE_RUNTIME_PATH must point to the portable node.exe included with this release.");
  }
  await requireFile(nodeRuntimePath, "Portable Node.js runtime");
  await requireFile(path.join(rootDirectory, "dist", "web", "index.html"), "Built web application");

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(applicationDirectory, { recursive: true });
  await Promise.all([
    cp(path.join(rootDirectory, "src"), path.join(applicationDirectory, "src"), { recursive: true }),
    cp(path.join(rootDirectory, "dist"), path.join(applicationDirectory, "dist"), { recursive: true }),
    copyFile(path.join(rootDirectory, "package.json"), path.join(applicationDirectory, "package.json")),
    copyFile(path.join(rootDirectory, "package-lock.json"), path.join(applicationDirectory, "package-lock.json")),
    copyFile(path.join(rootDirectory, "installer", "launcher.vbs"), path.join(applicationDirectory, "XSOAR Incident Assistant.vbs"))
  ]);
  await mkdir(path.join(applicationDirectory, "runtime"), { recursive: true });
  await copyFile(nodeRuntimePath, path.join(applicationDirectory, "runtime", "node.exe"));

  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) throw new Error("Run packaging through npm so its locked dependency installer is available.");
  await run(process.execPath, [npmCliPath, "ci", "--omit=dev", "--ignore-scripts"], { cwd: applicationDirectory });
  await requireFile(path.join(applicationDirectory, "node_modules", "playwright-core", "package.json"), "Staged Playwright dependency");
}

async function main() {
  await stageRelease();
  const compiler = isccPath();
  await requireFile(compiler, "Inno Setup compiler");
  await mkdir(outputDirectory, { recursive: true });
  await run(compiler, [
    "/Qp",
    `/DAppVersion=${appVersion()}`,
    `/DStageDir=${applicationDirectory}`,
    `/O${outputDirectory}`,
    path.join(rootDirectory, "installer", "XSOARIncidentAssistant.iss")
  ]);
}

main().catch((error) => {
  console.error(`Windows installer packaging failed: ${error.message}`);
  process.exitCode = 1;
});
