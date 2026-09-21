import test from "node:test";
import assert from "node:assert/strict";

import { resolveSettings } from "../src/domain.js";
import { runIncidentDraft } from "../src/workflow.js";

function createAdapter({
  incidentRedirect,
  currentIncident = {},
  historicalIncidents = {},
  historicalViews = {},
  searchError,
  searchTicketIds = ["4200", "4199", "4198", "4197"],
  onExtract = () => {},
  onSearch = () => {}
} = {}) {
  const tabs = new Map([[1, "https://xsoar.example.test/Custom/GenericLayout/4200"]]);
  const opened = [];
  const closed = [];
  let nextId = 2;
  return {
    opened,
    closed,
    focused: [],
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
      return url;
    },
    async extractIncident(id, extractionSettings) {
      const currentUrl = tabs.get(id);
      onExtract({ url: currentUrl, settings: extractionSettings });
      const ticketId = currentUrl.match(/\/(\d+)(?:[?#]|$)/)?.[1] || "4200";
      if (ticketId !== "4200") {
        return {
          ticketId,
          customerName: "Example Organisation",
          ruleName: "Example Rule",
          caseType: "Endpoint",
          closeNotes: `Resolved incident ${ticketId}`,
          ...historicalIncidents[ticketId],
          ...historicalViews[currentUrl]
        };
      }
      return {
        ticketId,
        incidentName: "Example detection",
        ruleName: "Example Rule",
        caseType: "Endpoint",
        customerName: "Example Organisation",
        tabUrls: [],
        ...currentIncident
      };
    },
    async extractSearchResults(id, options) {
      onSearch(options);
      if (searchError) throw searchError;
      return { ticketIds: searchTicketIds.slice(0, options.maxResults), truncated: searchTicketIds.length > options.maxResults };
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

test("workflow searches three months of same-client alert history while AI processes the current alert", async () => {
  let aiPending = false;
  let searchedWhileAiPending = false;
  let searchOptions;
  const adapter = createAdapter({
    historicalIncidents: {
      4198: { customerName: "Different Organisation" },
      4197: { caseType: "Different Type" }
    },
    onSearch: (options) => {
      searchedWhileAiPending = aiPending;
      searchOptions = options;
    }
  });
  const result = await runIncidentDraft({
    adapter,
    settings,
    enrichDraft: async () => {
      aiPending = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
      aiPending = false;
      return { eventSummary: "Current alert summary.", observedFacts: [] };
    }
  });

  assert.equal(searchedWhileAiPending, true);
  assert.match(searchOptions.expectedQuery, /rawName:"Example Rule"/);
  assert.match(searchOptions.expectedQuery, /created:>="3 months ago"/);
  assert.match(result.draft, /Historic\n1\. #4199: Resolved incident 4199/);
  assert.doesNotMatch(result.draft, /#4198|#4197/);
});

test("workflow continues past other clients until it finds the requested number of same-client resolutions", async () => {
  const searchTicketIds = ["4200", ...Array.from({ length: 20 }, (_, index) => String(4199 - index)), "4179"];
  const historicalIncidents = Object.fromEntries(
    searchTicketIds.slice(1, -1).map((ticketId) => [ticketId, { customerName: "Different Organisation" }])
  );
  const result = await runIncidentDraft({
    adapter: createAdapter({ searchTicketIds, historicalIncidents }),
    settings: resolveSettings({ ...settings, maxHistoricalIncidents: 1 })
  });

  assert.match(result.draft, /Historic\n1\. #4179: Resolved incident 4179/);
  assert.equal(result.reviewed, 1);
});

test("workflow skips unresolved matches before applying the historic resolution limit", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter({
      searchTicketIds: ["4200", "4199", "4198", "4197", "4196"],
      historicalIncidents: {
        4199: { closeNotes: "" },
        4198: { closeNotes: "" },
        4197: { closeNotes: "" }
      }
    }),
    settings: resolveSettings({ ...settings, maxHistoricalIncidents: 1 })
  });

  assert.match(result.draft, /Historic\n1\. #4196: Resolved incident 4196/);
  assert.equal(result.reviewed, 1);
});

test("workflow merges trusted detail views for historic identity and resolution fields", async () => {
  const detailUrl = "https://xsoar.example.test/Custom/GenericLayout/4199?view=Investigation";
  const extractionCalls = [];
  const result = await runIncidentDraft({
    adapter: createAdapter({
      searchTicketIds: ["4200", "4199"],
      historicalIncidents: {
        4199: { customerName: "", ruleName: "", caseType: "", closeNotes: "", tabUrls: [detailUrl] }
      },
      historicalViews: {
        [detailUrl]: {
          customerName: "Example Organisation",
          ruleName: "Example Rule",
          caseType: "Endpoint",
          closeNotes: "Resolved from the investigation view"
        }
      },
      onExtract: (call) => extractionCalls.push(call)
    }),
    settings: resolveSettings({ ...settings, maxHistoricalIncidents: 1 })
  });

  assert.match(result.draft, /#4199: Resolved from the investigation view/);
  assert.ok(extractionCalls.some(({ url }) => url === detailUrl));
  assert.ok(extractionCalls.some(({ url, settings: extractionSettings }) =>
    url.endsWith("/4199") && extractionSettings.requiredFields?.includes("customerName")));
});

test("workflow opens an explicitly requested incident and closes that temporary tab", async () => {
  const adapter = createAdapter();
  await runIncidentDraft({ adapter, settings, incidentId: "4200" });

  assert.equal(adapter.opened[0], "https://xsoar.example.test/Custom/GenericLayout/4200");
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
    incidentPathTemplate: "/Custom/case/{id}"
  });

  await runIncidentDraft({ adapter, settings: routedSettings, incidentId: "4200" });

  assert.equal(adapter.opened[0], "https://xsoar.example.test/Custom/case/4200");
  assert.equal(adapter.opened.length, 5);
});

test("workflow retains the source-field response if local processing fails", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter(), settings,
    enrichDraft: async () => { throw new Error("Ollama offline"); }
  });
  assert.match(result.draft, /Processed Incident Data/);
  assert.match(result.warning, /source-field response is ready/);
  assert.equal(result.aiEnriched, false);
});

test("workflow reports a safe detailed-JSON failure instead of hiding it", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter(), settings,
    enrichDraft: async () => { throw new Error("The complete detailed alert JSON was not available for local processing."); }
  });
  assert.match(result.warning, /complete detailed alert JSON was not available/);
});

test("workflow removes browser stack traces from historic timeout warnings", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter({
      searchError: new Error("page.evaluate: Error: XSOAR historic search results did not become ready before the timeout.\n    at <anonymous>:65:11")
    }),
    settings
  });
  assert.match(result.warning, /Historic incident lookup was unavailable: XSOAR historic search results did not become ready before the timeout\./);
  assert.doesNotMatch(result.warning, /page\.evaluate|anonymous|\n/);
});

test("workflow retains the source-field response if local processing returns no facts", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter(), settings,
    enrichDraft: async () => ({ eventSummary: "", observedFacts: [] })
  });
  assert.match(result.draft, /Event info breakdown/);
  assert.match(result.warning, /source-field response is ready/);
  assert.equal(result.aiEnriched, false);
});

test("workflow inserts factual local processing without changing browser concurrency", async () => {
  let enrichmentInput;
  const result = await runIncidentDraft({
    adapter: createAdapter({ currentIncident: { customerName: "" } }), settings,
    enrichDraft: async (input) => {
      enrichmentInput = input;
      return {
        eventSummary: "The source record names endpoint-01.",
        observedFacts: ["Source IP: 192.0.2.10"]
      };
    }
  });
  assert.deepEqual(Object.keys(enrichmentInput), ["incident"]);
  assert.match(result.draft, /The source record names endpoint-01/);
  assert.match(result.draft, /Source IP: 192\.0\.2\.10/);
  assert.match(result.draft, /Event info breakdown is as follows:/i);
  assert.doesNotMatch(result.draft, /Hello n\/a/i);
  assert.doesNotMatch(result.draft, /Recommended Actions|Vendor Guidance|Related Ticket Records/);
  assert.equal(result.aiEnriched, true);
});
