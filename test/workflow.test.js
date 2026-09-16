import test from "node:test";
import assert from "node:assert/strict";

import { resolveSettings } from "../src/domain.js";
import { runIncidentDraft } from "../src/workflow.js";

function createAdapter({ searchRedirect, incidentRedirect } = {}) {
  const tabs = new Map([[1, "https://xsoar.example.test/Custom/GenericLayout/4200"]]);
  const opened = [];
  const closed = [];
  let nextId = 2;
  let activeHistoricalReads = 0;
  let maxHistoricalConcurrency = 0;
  return {
    opened,
    closed,
    focused: [],
    searchOptions: null,
    get maxHistoricalConcurrency() { return maxHistoricalConcurrency; },
    async getActiveTab() { return { id: 1, url: tabs.get(1) }; },
    async openTab(url) {
      const tab = { id: nextId++, url };
      tabs.set(tab.id, url);
      opened.push(url);
      return tab;
    },
    async getTabUrl(id) {
      const url = tabs.get(id);
      if (id === 2 && incidentRedirect) return incidentRedirect;
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
      activeHistoricalReads += 1;
      maxHistoricalConcurrency = Math.max(maxHistoricalConcurrency, activeHistoricalReads);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeHistoricalReads -= 1;
      return { ticketId, classification: "Benign", closeNotes: `Reviewed incident ${ticketId}` };
    },
    async extractSearchResults(id, options) {
      this.searchOptions = options;
      return {
        ticketIds: ["4200", "4199", "4198", "4197"]
      };
    },
    async closeTab(id) { closed.push(id); tabs.delete(id); },
    async focusTab(id) { this.focused.push(id); }
  };
}

const settings = resolveSettings({
  allowedOrigin: "https://xsoar.example.test",
  incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+\\/?(?:[?#].*)?$",
  maxHistoricalIncidents: 3
});

test("workflow searches through the URL, excludes the current incident, and restores the tab", async () => {
  const adapter = createAdapter();
  const result = await runIncidentDraft({ adapter, settings });

  const searchUrl = new URL(adapter.opened[0]);
  assert.equal(searchUrl.pathname, "/incidents");
  assert.match(searchUrl.searchParams.get("query"), /name:"Example Rule" and type:"Endpoint"/);
  assert.equal(adapter.searchOptions.maxResults, 4);
  assert.deepEqual(adapter.opened.slice(1).sort(), [
    "https://xsoar.example.test/Custom/GenericLayout/4199",
    "https://xsoar.example.test/Custom/GenericLayout/4198",
    "https://xsoar.example.test/Custom/GenericLayout/4197"
  ].sort());
  assert.equal(adapter.maxHistoricalConcurrency, 2);
  assert.equal(result.reviewed, 3);
  assert.match(result.draft, /#4199: Reviewed incident 4199/);
  assert.ok(result.draft.indexOf("#4199") < result.draft.indexOf("#4198"));
  assert.ok(result.draft.indexOf("#4198") < result.draft.indexOf("#4197"));
  assert.deepEqual(adapter.focused, [1]);
  assert.equal(adapter.closed.length, 4);
});

test("workflow opens an explicitly requested incident and closes that temporary tab", async () => {
  const adapter = createAdapter();
  const result = await runIncidentDraft({ adapter, settings, incidentId: "4200" });

  assert.equal(adapter.opened[0], "https://xsoar.example.test/Custom/GenericLayout/4200");
  assert.equal(result.reviewed, 3);
  assert.deepEqual(adapter.focused, []);
  assert.equal(adapter.closed.length, 5);
});

test("workflow closes an explicitly requested tab when XSOAR redirects to another incident", async () => {
  const adapter = createAdapter({
    incidentRedirect: "https://xsoar.example.test/Custom/GenericLayout/4201"
  });

  await assert.rejects(
    () => runIncidentDraft({ adapter, settings, incidentId: "4200" }),
    /different incident/
  );
  assert.deepEqual(adapter.closed, [2]);
  assert.deepEqual(adapter.focused, []);
});

test("workflow uses a configured incident route with the ID in the final path segment", async () => {
  const adapter = createAdapter();
  const routedSettings = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/case\\/\\d+\\/?$",
    incidentPathTemplate: "/Custom/case/{id}",
    maxHistoricalIncidents: 3
  });

  const result = await runIncidentDraft({ adapter, settings: routedSettings, incidentId: "4200" });

  assert.equal(adapter.opened[0], "https://xsoar.example.test/Custom/case/4200");
  assert.deepEqual(adapter.opened.slice(2).sort(), [
    "https://xsoar.example.test/Custom/case/4199",
    "https://xsoar.example.test/Custom/case/4198",
    "https://xsoar.example.test/Custom/case/4197"
  ].sort());
  assert.equal(result.reviewed, 3);
});

test("workflow fails closed when XSOAR removes or changes the URL query", async () => {
  const adapter = createAdapter({ searchRedirect: "https://xsoar.example.test/incidents" });

  await assert.rejects(() => runIncidentDraft({ adapter, settings }), /did not retain/);
  assert.deepEqual(adapter.focused, [1]);
  assert.equal(adapter.closed.length, 1);
});

test("workflow retains the rules-based response if local enrichment fails", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter(), settings,
    enrichDraft: async () => { throw new Error("Ollama offline"); }
  });
  assert.match(result.draft, /Investigation Summary\nx x x/);
  assert.match(result.warning, /rules-based response is ready/);
  assert.equal(result.aiEnriched, false);
});

test("workflow inserts injected local enrichment without changing browser concurrency", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter(), settings,
    enrichDraft: async () => ({
      investigationSummary: "Review the event with the asset owner.",
      relatedActivity: "Compare supplied matching incidents.",
      vendorGuidance: "Use applicable vendor documentation.",
      recommendations: ["Confirm containment requirements."]
    })
  });
  assert.match(result.draft, /Review the event with the asset owner/);
  assert.match(result.draft, /Confirm containment requirements/);
  assert.equal(result.aiEnriched, true);
});
