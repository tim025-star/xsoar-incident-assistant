import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_LAYA_CHECKPOINT } from "../src/laya-mapper.js";
import { LAYA_MODEL } from "../src/laya-targets.js";

test("experimental pilot identity cannot become the normal workflow checkpoint", () => {
  assert.equal(LAYA_MODEL.experimental, true);
  assert.equal(LAYA_MODEL.diagnosticsOnly, true);
  assert.equal(LAYA_MODEL.promotionEligible, false);
  assert.equal(DEFAULT_LAYA_CHECKPOINT, "base-english");
  assert.notEqual(LAYA_MODEL.id, DEFAULT_LAYA_CHECKPOINT);
});

test("portable pilot uses bundle-relative assets and in-memory state", async () => {
  const [server, launcher, packager, ui] = await Promise.all([
    readFile(new URL("../scripts/serve-laya-pilot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../installer/pilot-launcher.cmd", import.meta.url), "utf8"),
    readFile(new URL("../scripts/package-laya-pilot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/src/index.tsx", import.meta.url), "utf8")
  ]);
  assert.match(server, /in-memory state|in-memory settings/i);
  assert.match(server, /layaMapperInstaller: \{ installInference: disabled/);
  assert.match(server, /layaDataset:/);
  assert.match(server, /layaTraining:/);
  assert.match(launcher, /%~dp0laya-mapper\\runtime-v2\\laya-mapper\.exe/);
  assert.match(launcher, /%~dp0laya-mapper\\models\\__PILOT_MODEL_ID__/);
  assert.doesNotMatch(launcher, /LOCALAPPDATA|Program Files|powershell/i);
  assert.match(packager, /experimental-laya-pilot-portable/);
  assert.match(packager, /promotionEligible: false/);
  assert.match(ui, /EXPERIMENTAL — human review required — not production mapping/);
  assert.doesNotMatch(ui, /id="installLayaMapper"/);
});
