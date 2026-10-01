import test from "node:test";
import assert from "node:assert/strict";
import { resolveAppConfig } from "../src/config.js";
import { DEFAULT_SETTINGS } from "../src/domain.js";
import { renderHistoricQuery } from "../src/historic-query.js";

test("old built-in history queries migrate in every mode while custom queries survive", async () => {
  const legacy = Object.fromEntries(["historicQueryTemplate", "historicQueryJson", "historicQueryJavaScript"]
    .map((key) => [key, DEFAULT_SETTINGS[key].replace("name:", "rawName:")]));
  for (const historicQueryMode of ["template", "json", "javascript"]) {
    const config = resolveAppConfig({
      configVersion: 14,
      xsoar: { allowedOrigin: "https://xsoar.example.test", historicQueryMode, ...legacy }
    });
    assert.equal(await renderHistoricQuery(config.xsoar, { incidentName: "Alert", tenantName: "Tenant" }),
      'name:"Alert" and tenantname:"Tenant" and (created:>="3 months ago")');
  }
  const custom = {
    historicQueryTemplate: 'rawName:{incidentName} and tenantname:{tenantName}',
    historicQueryJson: '{"query":"status:closed"}',
    historicQueryJavaScript: 'function buildQuery() { return "status:closed"; }'
  };
  const config = resolveAppConfig({ configVersion: 14, xsoar: {
    allowedOrigin: "https://xsoar.example.test", ...custom, fieldLabels: { tenantName: ["Custom Tenant"] }
  } });
  for (const [key, value] of Object.entries(custom)) assert.equal(config.xsoar[key], value);
  assert.deepEqual(config.xsoar.fieldLabels.tenantName, ["Account Short Name", "Custom Tenant"]);
  assert.deepEqual(resolveAppConfig(config), config);
});

test("Laya incident routing is opt-in and survives config resolution", () => {
  assert.equal(resolveAppConfig({}, { requireTenant: false }).layaMapper.enabled, false);
  const enabled = resolveAppConfig({ layaMapper: { enabled: true } }, { requireTenant: false });
  assert.equal(enabled.layaMapper.enabled, true);
});
