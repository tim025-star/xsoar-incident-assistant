import test from "node:test";
import assert from "node:assert/strict";
import { resolveAppConfig } from "../src/config.js";

test("Laya incident routing is opt-in and survives config resolution", () => {
  assert.equal(resolveAppConfig({}, { requireTenant: false }).layaMapper.enabled, false);
  const enabled = resolveAppConfig({ layaMapper: { enabled: true } }, { requireTenant: false });
  assert.equal(enabled.layaMapper.enabled, true);
});
