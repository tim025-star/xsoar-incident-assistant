import test from "node:test";
import assert from "node:assert/strict";

import { resolveSettings } from "../src/domain.js";
import { renderHistoricQuery } from "../src/historic-query.js";

const settings = (changes = {}) => resolveSettings({
  allowedOrigin: "https://xsoar.example.test",
  ...changes
});
const incident = { incidentName: 'Alert "A"', tenantName: "Tenant North", ticketId: "4200" };

test("template and JSON historic queries insert escaped incident values", async () => {
  const template = 'rawName:{incidentName} and tenantname:{tenantName}';
  const expected = 'rawName:"Alert \\"A\\"" and tenantname:"Tenant North"';
  assert.equal(await renderHistoricQuery(settings({ historicQueryTemplate: template }), incident), expected);
  assert.equal(await renderHistoricQuery(settings({
    historicQueryMode: "json",
    historicQueryJson: JSON.stringify({ query: template })
  }), incident), expected);
  assert.throws(() => settings({ historicQueryMode: "json", historicQueryJson: '{"query":42}' }), /non-empty "query"/);
  assert.equal(
    await renderHistoricQuery(settings({ historicQueryMode: "json" }), incident),
    await renderHistoricQuery(settings(), incident)
  );
  assert.equal(
    await renderHistoricQuery(settings({ historicQueryMode: "javascript" }), incident),
    await renderHistoricQuery(settings(), incident)
  );
});

test("JavaScript historic query supports conditionals without Node or browser globals", async () => {
  const query = await renderHistoricQuery(settings({
    historicQueryMode: "javascript",
    historicQueryJavaScript: `
      function buildQuery(incident, quote) {
        if (typeof process !== "undefined" || typeof fetch !== "undefined") throw Error("Host API exposed");
        if (incident.tenantName === "Tenant North") {
          return \`rawName:\${quote(incident.incidentName)} and tenantname:\${quote(incident.tenantName)} and status:closed\`;
        }
        return "status:open";
      }
    `
  }), incident);
  assert.equal(query, 'rawName:"Alert \\"A\\"" and tenantname:"Tenant North" and status:closed');
});

test("JavaScript historic query must return a bounded string", async () => {
  await assert.rejects(
    renderHistoricQuery(settings({ historicQueryMode: "javascript", historicQueryJavaScript: "function buildQuery() { return 42; }" }), incident),
    /must return a string/
  );
  await assert.rejects(
    renderHistoricQuery(settings({ historicQueryMode: "javascript", historicQueryJavaScript: "function buildQuery() { while (true) {} }" }), incident),
    /interrupted|time limit/i
  );
});
