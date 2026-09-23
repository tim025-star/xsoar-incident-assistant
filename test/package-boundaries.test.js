import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("the core application has no trainer runtime or RPC surface", async () => {
  const root = new URL("../", import.meta.url);
  const [sourceFiles, rpc, mapperInstaller, mapperCli, coreInstaller, corePackager] = await Promise.all([
    readdir(new URL("src/", root)),
    readFile(new URL("src/rpc.js", root), "utf8"),
    readFile(new URL("src/laya-mapper-installer.js", root), "utf8"),
    readFile(new URL("scripts/install-laya-mapper.mjs", root), "utf8"),
    readFile(new URL("installer/XSOARIncidentAssistant.iss", root), "utf8"),
    readFile(new URL("scripts/package-windows.mjs", root), "utf8")
  ]);

  assert.ok(!sourceFiles.includes("laya-training.js"));
  assert.ok(!sourceFiles.includes("laya-dataset.js"));
  assert.doesNotMatch(rpc, /layaTraining|layaDataset|installTrainingTools/);
  assert.doesNotMatch(mapperInstaller, /installTrainingTools|laya-trainer|training-runtime/);
  assert.doesNotMatch(mapperCli, /training-backend|fine-tuning tools/);
  assert.doesNotMatch(coreInstaller, /Laya Trainer|training-backend|fine-tuning/i);
  assert.doesNotMatch(corePackager, /trainer[\\/](?:python|scripts|installer)|LayaTrainer\.iss/);
});

test("the optional trainer has a distinct Windows product identity", async () => {
  const root = new URL("../", import.meta.url);
  const [installer, packager, readme] = await Promise.all([
    readFile(new URL("trainer/installer/LayaTrainer.iss", root), "utf8"),
    readFile(new URL("trainer/scripts/package-windows.mjs", root), "utf8"),
    readFile(new URL("trainer/README.md", root), "utf8")
  ]);

  assert.match(installer, /^AppId=\{\{93D7419E-FB6E-47B5-A3E7-92A1F1E9B08D\}$/m);
  assert.match(installer, /^DefaultDirName=\{localappdata\}\\Programs\\\{#AppName\}$/m);
  assert.match(installer, /XSOAR-Laya-Trainer-Setup-\{#AppVersion\}-\{#TrainerBackend\}-x64/);
  assert.doesNotMatch(installer, /installlayamapper|installollama|XSOAR Incident Assistant\.vbs/i);
  assert.match(packager, /TRAINER_RUNTIME_DIRECTORY/);
  assert.match(packager, /trainer-install\.json/);
  assert.match(packager, /\$\{installerPath\}\.sha256/);
  assert.doesNotMatch(packager, /path\.join\(rootDirectory, "src"\)|package:windows/);
  assert.match(readme, /production application never imports this module/i);
});
