import test from "node:test";
import assert from "node:assert/strict";

import {
  assertIncidentUrl,
  assertSearchUrl,
  buildDraft,
  buildHistoricalIncidentUrl,
  buildIncidentSearchUrl,
  buildSearchQuery,
  permissionPatternForOrigin,
  resolveSettings
} from "../extension/domain.js";

const settings = () => resolveSettings({
  allowedOrigin: "https://xsoar.example.test",
  incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+\\/?(?:[?#].*)?$"
});

test("settings accept one exact HTTPS origin and keep the analyst name configurable", () => {
  const resolved = settings();
  assert.equal(resolved.allowedOrigin, "https://xsoar.example.test");
  assert.equal(resolved.template.analystName, "");
  assert.equal(permissionPatternForOrigin(resolved.allowedOrigin), "https://xsoar.example.test/*");

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

test("incident and historical navigation remain in the configured tenant and path", () => {
  const resolved = settings();
  const current = "https://xsoar.example.test/Custom/GenericLayout/4200";

  assert.equal(assertIncidentUrl(current, resolved).pathname, "/Custom/GenericLayout/4200");
  assert.equal(
    buildHistoricalIncidentUrl(current, "4199", resolved),
    "https://xsoar.example.test/Custom/GenericLayout/4199"
  );
  assert.throws(
    () => buildHistoricalIncidentUrl(current, "../admin", resolved),
    /must be numeric/
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
