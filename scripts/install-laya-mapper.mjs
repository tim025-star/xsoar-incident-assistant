import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLayaMapperInstaller, loadLayaInstallManifest } from "../src/laya-mapper-installer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestIndex = process.argv.indexOf("--manifest");
const manifestPath = manifestIndex >= 0
  ? path.resolve(process.argv[manifestIndex + 1] || "")
  : path.join(root, "resources", "laya-mapper-manifest.json");
const offlineIndex = process.argv.indexOf("--offline-directory");
const offlineDirectory = offlineIndex >= 0 ? process.argv[offlineIndex + 1] : "";
const trainingIndex = process.argv.indexOf("--training-backend");
const trainingBackend = trainingIndex >= 0 ? process.argv[trainingIndex + 1] : "";

try {
  if (trainingBackend && !["auto", "cpu", "cuda"].includes(trainingBackend)) {
    throw new Error("--training-backend must be auto, cpu, or cuda.");
  }
  const manifest = await loadLayaInstallManifest(manifestPath);
  const installer = createLayaMapperInstaller({
    manifest,
    offlineDirectories: offlineDirectory ? [offlineDirectory] : []
  });
  const install = trainingBackend ? installer.installTrainingTools.bind(installer) : installer.installInference.bind(installer);
  await install({
    ...(trainingBackend ? { backend: trainingBackend } : {}),
    onProgress: ({ status, completed, total }) => {
      const percent = total > 0 ? ` (${Math.min(100, Math.round((completed / total) * 100))}%)` : "";
      console.log(`${status}${percent}`);
    }
  });
  console.log(trainingBackend
    ? `Laya ${trainingBackend.toUpperCase()} fine-tuning tools are ready.`
    : "Laya-mapper is ready for local field mapping.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Laya-mapper installation failed.");
  process.exitCode = 1;
}
