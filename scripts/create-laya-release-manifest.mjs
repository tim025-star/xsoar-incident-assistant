import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LAYA_CHECKPOINT_ID, LAYA_MODEL } from "../src/laya-targets.js";

const [runtimePath, modelDirectory, outputDirectory, repository, releaseTag] = process.argv.slice(2);
if (![runtimePath, modelDirectory, outputDirectory, repository, releaseTag].every(Boolean)) {
  throw new Error("Usage: create-laya-release-manifest <runtime-archive> <model-dir> <output-dir> <owner/repo> <release-tag>");
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9._-]+$/.test(releaseTag)) {
  throw new Error("The GitHub repository or release tag is invalid.");
}

async function files(root, current = root) {
  const values = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) values.push(...await files(root, absolute));
    else if (entry.isFile()) values.push({ absolute, relative: path.relative(root, absolute).replaceAll("\\", "/") });
  }
  return values;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function stage(source, name, extra = {}) {
  const destination = path.join(outputDirectory, name);
  await copyFile(source, destination);
  return {
    name,
    ...extra,
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(name)}`,
    size: (await stat(destination)).size,
    sha256: await sha256File(destination)
  };
}

await mkdir(outputDirectory, { recursive: true });
const runtime = await stage(runtimePath, "laya-mapper-runtime-cpu-x64.tar.gz", { entry: "laya-mapper.exe" });
const modelFiles = [];
for (const item of await files(modelDirectory)) {
  if (item.relative.startsWith(".cache/")) continue;
  const assetName = `laya-english-${item.relative.replaceAll("/", "--")}`;
  modelFiles.push(await stage(item.absolute, assetName, { path: item.relative }));
}
const training = JSON.parse(await readFile(path.join(modelDirectory, "manifest.json"), "utf8"));
const weights = modelFiles.find((item) => item.path === "model.safetensors");
const trainingComplete = training.optimizerSteps === training.expectedOptimizerSteps
  && training.epochsCompleted === training.maximumEpochs
  && training.reloadVerification?.choicesEqual === true
  && training.reloadVerification?.finiteState === true
  && training.reloadVerification?.maximumLogitDelta === 0
  && training.reloadVerification?.probeSequences === training.developmentSequences;
if (training.id !== LAYA_CHECKPOINT_ID || !weights
  || training.promotionEligible !== false || !trainingComplete
  || !Number.isInteger(training.trainingSequences) || !Number.isInteger(training.developmentSequences)
  || !Number.isFinite(training.sequenceMetrics?.sequenceAccuracy)) {
  throw new Error("The model directory does not contain a fully verified demo checkpoint manifest.");
}
const checkpoint = {
  id: training.id,
  label: "Reviewed 632-alert Laya demo",
  channel: "demo",
  weightsSha256: weights.sha256,
  trainingComplete,
  promotionEligible: false,
  trainingSequences: training.trainingSequences,
  developmentSequences: training.developmentSequences,
  sequenceAccuracy: training.sequenceMetrics.sequenceAccuracy,
  warning: "Experimental tuned checkpoint. Development comparison only; review every mapping before use."
};
const manifest = { schemaVersion: 4, protocolVersion: 2, layaVersion: "0.3.5", model: LAYA_MODEL, checkpoint, runtime, modelFiles };
await writeFile(path.join(outputDirectory, "laya-mapper-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
