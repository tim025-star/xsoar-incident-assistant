import test from "node:test";
import assert from "node:assert/strict";

import { resolveSettings } from "../src/domain.js";
import { extractIncidentFromPage } from "../src/page-adapter.js";
import { runIncidentDraft } from "../src/workflow.js";

const visible = { offsetWidth: 1, offsetHeight: 1, getClientRects: () => [1] };

function field(value) {
  const element = { ...visible, textContent: value, getAttribute: () => null };
  const root = {
    querySelectorAll: (selector) => selector === ".text-field-display-value" ? [element] : []
  };
  return {
    ...visible,
    matches: (selector) => selector === ".field-wrapper",
    querySelector: (selector) => selector === ".value-wrapper" ? root : null,
    querySelectorAll: () => []
  };
}

test("processing waits for incident search identity after other fields have settled", async (t) => {
  const settings = resolveSettings({ allowedOrigin: "https://xsoar.example.test", pageReadyTimeoutMs: 2500 });
  const started = Date.now();
  const rule = field("Synthetic Rule");
  const tenant = field("Tenant Alpha");
  const identityReady = () => Date.now() - started >= 900;
  const original = { location: globalThis.location, window: globalThis.window, document: globalThis.document };
  t.after(() => Object.assign(globalThis, original));
  globalThis.location = new URL("https://xsoar.example.test/Custom/GenericLayout/4200");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    querySelector(selector) {
      if (selector === ".header-inv-id") return { textContent: "4200" };
      if (selector === ".header-inv-title" && identityReady()) {
        return { textContent: "Synthetic incident", getAttribute: () => null };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".field-wrapper") return identityReady() ? [rule, tenant] : [rule];
      if (selector === ".fieldId-rulename") return [rule];
      if (selector === ".fieldId-tenantname" && identityReady()) return [tenant];
      return [];
    }
  };
  let submittedQuery = "";
  const result = await runIncidentDraft({
    settings,
    adapter: {
      getActiveTab: async () => ({ id: 1, url: location.href }),
      extractIncident: async (_id, options) => extractIncidentFromPage(options),
      openTab: async (url) => ({ id: 2, url }),
      focusTab: async () => {},
      closeTab: async () => {},
      extractSearchResults: async (_id, options) => {
        submittedQuery = options.expectedQuery;
        return { ticketIds: [] };
      }
    }
  });
  assert.doesNotMatch(result.warning, /Historic incident lookup was unavailable/);
  assert.equal(submittedQuery, 'rawName:"Synthetic incident" and tenantname:"Tenant Alpha" and (created:>="3 months ago")');
});
