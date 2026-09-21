import test from "node:test";
import assert from "node:assert/strict";

import {
  assertIncidentRouteCompatibility,
  assertIncidentUrl,
  assertSearchUrl,
  buildDraft,
  buildHistoricalIncidentUrl,
  buildIncidentUrlFromId,
  buildIncidentSearchUrl,
  buildSearchQuery,
  resolveSettings
} from "../src/domain.js";

const settings = () => resolveSettings({
  allowedOrigin: "https://xsoar.example.test",
  incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+\\/?(?:[?#].*)?$"
});

test("settings accept one exact HTTPS origin and keep the analyst name configurable", () => {
  const resolved = settings();
  assert.equal(resolved.allowedOrigin, "https://xsoar.example.test");
  assert.equal(resolved.template.analystName, "");

  for (const origin of [
    "http://xsoar.example.test",
    "https://user:secret@xsoar.example.test",
    "https://xsoar.example.test/path",
    "https://xsoar.example.test?tenant=private"
  ]) {
    assert.throws(() => resolveSettings({ allowedOrigin: origin }), /XSOAR origin.*HTTPS|HTTPS origin/);
  }
});

test("historic searches use exact alert type and a verified three-month URL query", () => {
  const resolved = settings();
  const query = buildSearchQuery("Example Rule", "Endpoint", 'created:>="3 months ago"');
  const url = buildIncidentSearchUrl(resolved, query);

  assert.match(query, /^rawName:"Example Rule" and rawType:"Endpoint"/);
  assert.match(query, /created:>="3 months ago"/);
  assert.equal(new URL(buildIncidentSearchUrl(resolved, "")).search, "");
  assert.equal(assertSearchUrl(url, resolved, query).origin, resolved.allowedOrigin);
  assert.throws(
    () => assertSearchUrl("https://xsoar.example.test/incidents?query=changed", resolved, query),
    /did not retain/
  );
});

test("incident navigation remains in the configured tenant and path", () => {
  const resolved = settings();
  const current = "https://xsoar.example.test/Custom/GenericLayout/4200";

  assert.equal(assertIncidentUrl(current, resolved).pathname, "/Custom/GenericLayout/4200");
  assert.equal(
    buildIncidentUrlFromId("4199", resolved),
    "https://xsoar.example.test/Custom/GenericLayout/4199"
  );
  assert.equal(
    buildIncidentUrlFromId("4201", resolved),
    "https://xsoar.example.test/Custom/GenericLayout/4201"
  );
  assert.throws(() => buildIncidentUrlFromId("../admin", resolved), /must be numeric/);
  assert.throws(() => buildHistoricalIncidentUrl(current, "../admin", resolved), /must be numeric/);
  assert.throws(
    () => resolveSettings({
      allowedOrigin: "https://xsoar.example.test",
      incidentPathTemplate: "https://attacker.example/{id}"
    }),
    /absolute path on the configured XSOAR origin/
  );
  assert.throws(
    () => resolveSettings({ allowedOrigin: "https://xsoar.example.test", incidentsPath: "/incidents?query=stale" }),
    /incidentsPath must be an absolute path/
  );
});

test("incident templates require the ID as the final path segment and must match the route regex", () => {
  const resolved = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/case\\/\\d+\\/?$",
    incidentPathTemplate: "/Custom/case/{id}"
  });

  const url = buildIncidentUrlFromId("4200", resolved);
  assert.equal(url, "https://xsoar.example.test/Custom/case/4200");
  const trailingSlashSettings = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/case\\/\\d+\\/$",
    incidentPathTemplate: "/Custom/case/{id}/"
  });
  assert.equal(buildIncidentUrlFromId("4200", trailingSlashSettings), "https://xsoar.example.test/Custom/case/4200/");
  assert.doesNotThrow(() => assertIncidentRouteCompatibility(resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/case\\/\\d{6}$",
    incidentPathTemplate: "/Custom/case/{id}"
  })));
  assert.throws(
    () => resolveSettings({
      allowedOrigin: "https://xsoar.example.test",
      incidentUrlPattern: "\\/Custom\\/case-\\d+\\/view\\/?$",
      incidentPathTemplate: "/Custom/case-{id}/view"
    }),
    /final path segment/
  );
  assert.throws(
    () => assertIncidentRouteCompatibility(resolveSettings({
      allowedOrigin: "https://xsoar.example.test",
      incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
      incidentPathTemplate: "/Custom/case/{id}"
    })),
    /must match incidentUrlPattern/
  );
});

test("draft output contains configured identity only when the user supplies it", () => {
  const base = {
    customerName: "Example Organisation",
    incidentName: "Example detection",
    ticketId: "4200",
    ruleName: "Example Rule",
    caseType: "Endpoint"
  };
  const anonymous = buildDraft(base, settings().template);
  const named = buildDraft(base, { ...settings().template, analystName: "Example Analyst" });
  const missingCustomer = buildDraft({ ...base, customerName: "" }, settings().template);

  assert.doesNotMatch(anonymous, /Example Analyst/);
  assert.doesNotMatch(anonymous, /Security Analyst$/);
  assert.match(named, /Example Analyst\nSecurity Analyst\n\nHistoric/);
  assert.doesNotMatch(missingCustomer, /Hello n\/a/i);
});

test("processed output keeps the source-field template and adds facts without analysis or recommendations", () => {
  const draft = buildDraft({
    customerName: "Example Organisation",
    ticketId: "4200",
    incidentName: "Example detection",
    deviceHostname: "endpoint-01",
    classification: "Unreviewed",
    historical: [{ ticketId: "4199", closeNotes: "Reset the affected account." }]
  }, settings().template, {
    eventSummary: "The source record names endpoint-01.",
    observedFacts: ["Account: example.user", "Source IP: 192.0.2.10"]
  });

  assert.match(draft, /Incident ID: 4200/);
  assert.match(draft, /Affected entity: endpoint-01/);
  assert.match(draft, /Recorded classification: Unreviewed/);
  assert.match(draft, /Event info breakdown is as follows:/);
  assert.match(draft, /Processed Incident Data\nEvent Summary: The source record names endpoint-01\./);
  assert.match(draft, /Observed Facts:\n- Account: example\.user\n- Source IP: 192\.0\.2\.10/);
  assert.match(draft, /Kind regards,\n\nHistoric\n1\. #4199: Reset the affected account\./);
  assert.doesNotMatch(draft, /Investigation Summary|Related Activity|Recommended Actions|Vendor Guidance/);
});
