import test from "node:test";
import assert from "node:assert/strict";

import { resolveSettings } from "../extension/domain.js";
import { runIncidentDraft } from "../extension/workflow.js";

function createAdapter({ searchRedirect } = {}) {
  const tabs = new Map([[1, "https://xsoar.example.test/Custom/GenericLayout/4200"]]);
  const opened = [];
  const closed = [];
  let nextId = 2;
  return {
    opened,
    closed,
    focused: [],
    searchOptions: null,
    async getActiveTab() { return { id: 1, url: tabs.get(1) }; },
    async openTab(url) {
      const tab = { id: nextId++, url };
      tabs.set(tab.id, url);
      opened.push(url);
      return tab;
    },
    async waitUntilReady() {},
    async getTabUrl(id) {
      const url = tabs.get(id);
      return url.includes("/incidents?") && searchRedirect ? searchRedirect : url;
    },
    async extractIncident(id) {
      const ticketId = tabs.get(id).match(/\/(\d+)(?:[?#]|$)/)?.[1] || "4200";
      if (ticketId === "4200") {
        return {
          ticketId,
          incidentName: "Example detection",
          ruleName: "Example Rule",
          caseType: "Endpoint",
          customerName: "Example Organisation",
          tabUrls: []
        };
      }
      return { ticketId, classification: "Benign", closeNotes: `Reviewed incident ${ticketId}` };
    },
    async extractSearchResults(id, options) {
      this.searchOptions = options;
      return {
        total: 3,
        tickets: [
          { ticketId: "4200" },
          { ticketId: "4199" },
          { ticketId: "4198" }
        ]
      };
    },
    async closeTab(id) { closed.push(id); tabs.delete(id); },
    async focusTab(id) { this.focused.push(id); }
  };
}

const settings = resolveSettings({
  allowedOrigin: "https://xsoar.example.test",
  incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+\\/?(?:[?#].*)?$",
  maxHistoricalIncidents: 2
});

test("workflow searches through the URL, excludes the current incident, and restores the tab", async () => {
  const adapter = createAdapter();
  const result = await runIncidentDraft({ adapter, settings });

  const searchUrl = new URL(adapter.opened[0]);
  assert.equal(searchUrl.pathname, "/incidents");
  assert.match(searchUrl.searchParams.get("query"), /name:"Example Rule" and type:"Endpoint"/);
  assert.equal(adapter.searchOptions.maxResults, 3);
  assert.deepEqual(adapter.opened.slice(1), [
    "https://xsoar.example.test/Custom/GenericLayout/4199",
    "https://xsoar.example.test/Custom/GenericLayout/4198"
  ]);
  assert.equal(result.reviewed, 2);
  assert.match(result.draft, /#4199: Reviewed incident 4199/);
  assert.deepEqual(adapter.focused, [1]);
  assert.equal(adapter.closed.length, 3);
});

test("workflow fails closed when XSOAR removes or changes the URL query", async () => {
  const adapter = createAdapter({ searchRedirect: "https://xsoar.example.test/incidents" });

  await assert.rejects(() => runIncidentDraft({ adapter, settings }), /did not retain/);
  assert.deepEqual(adapter.focused, [1]);
  assert.equal(adapter.closed.length, 1);
});
