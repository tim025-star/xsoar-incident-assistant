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

test("searches are encoded in the incidents page URL and verified after navigation", () => {
  const resolved = settings();
  const query = buildSearchQuery('Rule "Quoted"', "Endpoint", 'created:>="7 days ago"');
  const url = buildIncidentSearchUrl(resolved, query);

  assert.equal(new URL(url).searchParams.get("query"), query);
  assert.equal(assertSearchUrl(url, resolved, query).origin, resolved.allowedOrigin);
  assert.throws(
    () => assertSearchUrl("https://xsoar.example.test/incidents?query=changed", resolved, query),
    /did not retain/
  );
  assert.throws(
    () => assertSearchUrl(`https://xsoar.example.test/other?query=${encodeURIComponent(query)}`, resolved, query),
    /incidents page path/
  );
  assert.throws(
    () => assertSearchUrl(`https://attacker.example/incidents?query=${encodeURIComponent(query)}`, resolved, query),
    /left the configured/
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
  assert.throws(
    () => buildHistoricalIncidentUrl(current, "../admin", resolved),
    /must be numeric/
  );
  assert.throws(() => buildIncidentUrlFromId("../admin", resolved), /must be numeric/);
  assert.throws(
    () => resolveSettings({
      allowedOrigin: "https://xsoar.example.test",
      incidentPathTemplate: "https://attacker.example/{id}"
    }),
    /absolute path on the configured XSOAR origin/
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
  assert.equal(buildHistoricalIncidentUrl(`${url}/`, "4199", resolved), "https://xsoar.example.test/Custom/case/4199/");
  const trailingSlashSettings = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/case\\/\\d+\\/$",
    incidentPathTemplate: "/Custom/case/{id}/"
  });
  assert.equal(
    buildHistoricalIncidentUrl("https://xsoar.example.test/Custom/case/4200/", "4199", trailingSlashSettings),
    "https://xsoar.example.test/Custom/case/4199/"
  );
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
    caseType: "Endpoint",
    historical: []
  };
  const anonymous = buildDraft(base, settings().template);
  const named = buildDraft(base, { ...settings().template, analystName: "Example Analyst" });

  assert.doesNotMatch(anonymous, /Example Analyst/);
  assert.doesNotMatch(anonymous, /Security Analyst$/);
  assert.match(named, /Example Analyst\nSecurity Analyst$/);
});

test("related ticket resolutions only use resolution-bearing fields", () => {
  const base = {
    customerName: "Example Organisation",
    incidentName: "Example detection",
    historical: [
      {
        ticketId: "4199",
        descriptionLong: "Alert description that must not be presented as a resolution",
        historicalSummary: "General related-ticket summary"
      }
    ]
  };

  const withoutResolution = buildDraft(base, settings().template);
  assert.match(withoutResolution, /Related Ticket Resolutions\nNo related ticket resolution was available\./);
  assert.doesNotMatch(withoutResolution, /#4199:/);

  const withResolution = buildDraft({
    ...base,
    historical: [{ ...base.historical[0], closeNotes: "Contained host and reset credentials." }]
  }, settings().template);
  assert.match(withResolution, /1\. #4199: Contained host and reset credentials\./);
});
