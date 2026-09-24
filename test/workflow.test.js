import test from "node:test";
import assert from "node:assert/strict";

import { resolveSettings } from "../src/domain.js";
import { runIncidentDraft } from "../src/workflow.js";

function createAdapter({
  incidentRedirect,
  currentIncident = {},
  historicalIncidents = {},
  historicalViews = {},
  historicFailuresBeforeSuccess = {},
  searchError,
  searchTicketIds = ["4200", "4199", "4198", "4197"],
  searchTicketUrls = {},
  searchTicketRows = {},
  onExtract = () => {},
  onSearch = () => {}
} = {}) {
  const tabs = new Map([[1, "https://xsoar.example.test/Custom/GenericLayout/4200"]]);
  const opened = [];
  const closed = [];
  const events = [];
  const attempts = new Map();
  let nextId = 2;
  return {
    opened,
    closed,
    events,
    focused: [],
    async getActiveTab() { return { id: 1, url: tabs.get(1) }; },
    async openTab(url, options = {}) {
      const tab = { id: nextId++, url };
      tabs.set(tab.id, url);
      opened.push(url);
      events.push(`open:${tab.id}`);
      if (options.focusBeforeNavigation) events.push(`foreground-navigation:${tab.id}`);
      return tab;
    },
    async reloadTab(id, url, options = {}) {
      if (options.focusBeforeNavigation) events.push(`foreground-reload:${id}`);
      events.push(`reload:${id}`);
      tabs.set(id, url);
    },
    async getTabUrl(id) {
      const url = tabs.get(id);
      if (id === 2 && incidentRedirect) return incidentRedirect;
      return url;
    },
    async extractIncident(id, extractionSettings) {
      const currentUrl = tabs.get(id);
      events.push(`extract:${id}`);
      onExtract({ url: currentUrl, settings: extractionSettings });
      const ticketId = currentUrl.match(/\/(\d+)(?:[?#]|$)/)?.[1] || "4200";
      if (ticketId !== "4200") {
        const attempt = (attempts.get(ticketId) || 0) + 1;
        attempts.set(ticketId, attempt);
        if (attempt <= Number(historicFailuresBeforeSuccess[ticketId] || 0)) {
          throw new Error(`Historic incident ${ticketId} did not expose usable resolution fields.`);
        }
        return {
          ticketId,
          incidentName: "Example detection",
          customerName: "Example Organisation",
          tenantName: "Example Organisation",
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
        tenantName: "Example Organisation",
        tabUrls: [],
        ...currentIncident
      };
    },
    async extractSearchResults(id, options) {
      onSearch(options);
      if (searchError) throw searchError;
      return { ticketIds: searchTicketIds.slice(0, options.maxResults), ticketUrls: searchTicketUrls, ticketRows: searchTicketRows, truncated: searchTicketIds.length > options.maxResults };
    },
    async closeTab(id) { events.push(`close:${id}`); closed.push(id); tabs.delete(id); },
    async focusTab(id) { events.push(`focus:${id}`); this.focused.push(id); }
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
      4198: { tenantName: "Different Organisation" },
      4197: { incidentName: "Different alert" }
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
  assert.equal(new URL(adapter.opened[0]).search, "");
  assert.match(searchOptions.expectedQuery, /rawName:"Example detection"/);
  assert.doesNotMatch(searchOptions.expectedQuery, /rawName:"Example Rule"/);
  assert.match(searchOptions.expectedQuery, /tenantname:"Example Organisation"/);
  assert.doesNotMatch(searchOptions.expectedQuery, /rawType/);
  assert.match(searchOptions.expectedQuery, /created:>="3 months ago"/);
  assert.match(result.draft, /Historic\n1\. #4199: Resolved incident 4199/);
  assert.doesNotMatch(result.draft, /#4198|#4197/);
});

test("workflow submits the configured historic query to Playwright", async () => {
  let query;
  await runIncidentDraft({
    adapter: createAdapter({ searchTicketIds: ["4200"], onSearch: (options) => { query = options.expectedQuery; } }),
    settings: resolveSettings({
      ...settings,
      historicQueryTemplate: 'name:{incidentName} and tenantname:{tenantName} and status:closed'
    })
  });
  assert.equal(query, 'name:"Example detection" and tenantname:"Example Organisation" and status:closed');
});

test("workflow visibly opens and completes each historic incident tab before starting the next", async () => {
  const adapter = createAdapter({ searchTicketIds: ["4200", "4199", "4198"] });

  await runIncidentDraft({
    adapter,
    settings: resolveSettings({ ...settings, maxHistoricalIncidents: 2 })
  });

  assert.deepEqual(adapter.events.filter((event) => !event.endsWith(":2") && event !== "extract:1"), [
    "open:3",
    "foreground-navigation:3",
    "focus:3",
    "extract:3",
    "close:3",
    "open:4",
    "foreground-navigation:4",
    "focus:4",
    "extract:4",
    "close:4",
    "focus:1"
  ]);
});

test("workflow opens the incident link supplied by a filtered XSOAR result row", async () => {
  const adapter = createAdapter({
    searchTicketIds: ["4200", "4199"],
    searchTicketUrls: { 4199: "https://xsoar.example.test/incident/4199" }
  });
  const result = await runIncidentDraft({ adapter, settings });

  assert.equal(adapter.opened[1], "https://xsoar.example.test/incident/4199");
  assert.match(result.draft, /#4199: Resolved incident 4199/);
});

test("historic review uses the verified result row when detail views omit duplicate identity fields", async () => {
  const adapter = createAdapter({
    searchTicketIds: ["4200", "4199"],
    searchTicketUrls: { 4199: "https://xsoar.example.test/incident/4199" },
    searchTicketRows: { 4199: { tenantName: "Example Organisation", name: "Example detection" } },
    historicalIncidents: { 4199: { customerName: "", ruleName: "", caseType: "", incidentName: "" } }
  });
  const result = await runIncidentDraft({ adapter, settings });

  assert.equal(adapter.opened[1], "https://xsoar.example.test/incident/4199");
  assert.match(result.draft, /#4199: Resolved incident 4199/);
  assert.equal(result.reviewed, 1);
});

test("historic review excludes a result row from a different tenant", async () => {
  const adapter = createAdapter({
    searchTicketIds: ["4200", "4199"],
    searchTicketRows: { 4199: { tenantName: "Different Tenant", name: "Example detection" } }
  });
  const result = await runIncidentDraft({ adapter, settings });

  assert.equal(result.reviewed, 0);
  assert.doesNotMatch(result.draft, /#4199: Resolved incident 4199/);
});

test("workflow retries an incomplete historic incident once in the foreground", async () => {
  const progress = [];
  const adapter = createAdapter({
    searchTicketIds: ["4200", "4199"],
    historicFailuresBeforeSuccess: { 4199: 1 }
  });

  const result = await runIncidentDraft({
    adapter,
    settings: resolveSettings({ ...settings, maxHistoricalIncidents: 1 }),
    onProgress: async (message) => progress.push(message)
  });

  assert.match(result.draft, /#4199: Resolved incident 4199/);
  assert.deepEqual(adapter.events.filter((event) => /^(?:focus|foreground-reload|reload|extract):3$/.test(event)), [
    "focus:3",
    "extract:3",
    "focus:3",
    "foreground-reload:3",
    "reload:3",
    "focus:3",
    "extract:3"
  ]);
  assert.ok(progress.some((message) => /Retrying historic incident #4199/.test(message)));
});

test("workflow reports the ticket and safe reason after both historic attempts fail", async () => {
  const progress = [];
  const result = await runIncidentDraft({
    adapter: createAdapter({
      searchTicketIds: ["4200", "4199"],
      historicFailuresBeforeSuccess: { 4199: 2 }
    }),
    settings: resolveSettings({ ...settings, maxHistoricalIncidents: 1 }),
    onProgress: async (message) => progress.push(message)
  });

  assert.match(result.warning, /Historic incident #4199 could not be read: Historic incident 4199 did not expose usable resolution fields\./);
  assert.ok(progress.some((message) => /Historic incident #4199 could not be read/.test(message)));
  assert.doesNotMatch(result.warning, /\n|at extractIncident/);
});

test("workflow continues past other clients until it finds the requested number of same-client resolutions", async () => {
  const searchTicketIds = ["4200", ...Array.from({ length: 20 }, (_, index) => String(4199 - index)), "4179"];
  const historicalIncidents = Object.fromEntries(
    searchTicketIds.slice(1, -1).map((ticketId) => [ticketId, { tenantName: "Different Organisation" }])
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
        4199: { tenantName: "", incidentName: "", closeNotes: "", tabUrls: [detailUrl] }
      },
      historicalViews: {
        [detailUrl]: {
          tenantName: "Example Organisation",
          incidentName: "Example detection",
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
    url.endsWith("/4199") && extractionSettings.requiredFields?.includes("tenantName")));
  assert.ok(extractionCalls.some(({ url, settings: extractionSettings }) =>
    url.endsWith("/4199") && extractionSettings.requiredAnyFields?.includes("closeNotes")));
});

test("workflow closes an explicitly requested incident after visibly reviewing its historic tabs", async () => {
  const adapter = createAdapter();
  await runIncidentDraft({ adapter, settings, incidentId: "4200" });

  assert.equal(adapter.opened[0], "https://xsoar.example.test/Custom/GenericLayout/4200");
  assert.deepEqual(adapter.focused, [3, 4, 5, 6]);
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
  assert.equal(result.processingMode, "Deterministic extraction");
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
  const extractionCalls = [];
  const result = await runIncidentDraft({
    adapter: createAdapter({
      currentIncident: { customerName: "" },
      onExtract: (call) => extractionCalls.push(call)
    }), settings,
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
  assert.equal(result.processingMode, "Deterministic extraction + Qwen enrichment");
  assert.equal(extractionCalls[0].settings.requireAlertJson, true);
});

test("Laya mapping populates canonical fields before deterministic template generation", async () => {
  const calls = [];
  const extractionCalls = [];
  const result = await runIncidentDraft({
    adapter: createAdapter({
      currentIncident: { sourceIp: "", alertJson: [{ opaque: "203.0.113.77" }], alertJsonComplete: true },
      searchTicketIds: ["4200"],
      onExtract: (call) => extractionCalls.push(call)
    }),
    settings,
    mapIncident: async ({ incident, targets }) => {
      calls.push({ incident, targets });
      return { fields: { sourceIp: "203.0.113.77" }, paths: { sourceIp: "/documents/0/opaque" }, statuses: { sourceIp: "selected" }, complete: true, sourceComplete: true, processingComplete: true, warning: "" };
    }
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].targets.includes("sourceIp"));
  assert.match(result.draft, /Source: 203\.0\.113\.77/);
  assert.equal(result.layaMapped, true);
  assert.deepEqual(result.layaFields, [{ key: "sourceIp", pointer: "/documents/0/opaque" }]);
  assert.deepEqual(result.layaTentativeFields, []);
  assert.equal(result.aiEnriched, false);
  assert.equal(result.processingMode, "Laya mapping");
  assert.equal(extractionCalls[0].settings.requireAlertJson, false);
});

test("Qwen receives Laya-mapped canonical fields when both local processors are enabled", async () => {
  let enrichedIncident;
  const result = await runIncidentDraft({
    adapter: createAdapter({
      currentIncident: { alertJson: [{ opaque: "example.user" }], alertJsonComplete: true },
      searchTicketIds: ["4200"]
    }),
    settings,
    mapIncident: async () => ({ fields: { sourceUsername: "example.user" }, statuses: { sourceUsername: "selected" }, complete: true, sourceComplete: true, processingComplete: true, warning: "" }),
    enrichDraft: async ({ incident }) => {
      enrichedIncident = incident;
      return { eventSummary: "Mapped event.", observedFacts: [] };
    }
  });
  assert.equal(enrichedIncident.sourceUsername, "example.user");
  assert.equal(result.layaMapped, true);
  assert.equal(result.aiEnriched, true);
  assert.equal(result.processingMode, "Laya mapping + Qwen enrichment");
});

test("Laya failure falls back to configured fields with a visible warning", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter({
      currentIncident: { sourceIp: "192.0.2.12", alertJson: [{ opaque: "value" }], alertJsonComplete: false },
      searchTicketIds: ["4200"]
    }),
    settings,
    mapIncident: async () => { throw new Error("private model detail"); }
  });
  assert.match(result.draft, /Source: 192\.0\.2\.12/);
  assert.match(result.warning, /configured source-field mappings were used/);
  assert.doesNotMatch(result.warning, /private model detail/);
  assert.equal(result.layaMapped, false);
  assert.equal(result.processingMode, "Deterministic extraction");
});

test("Laya output fields do not change historic incident matching", async () => {
  const result = await runIncidentDraft({
    adapter: createAdapter({
      currentIncident: { alertJson: [{ customer: "Other Organisation" }], alertJsonComplete: true },
      searchTicketIds: ["4200", "4199"]
    }),
    settings,
    mapIncident: async () => ({
      fields: { customerName: "Other Organisation" },
      statuses: { customerName: "selected" },
      complete: true, sourceComplete: true, processingComplete: true
    })
  });
  assert.match(result.draft, /Other Organisation/);
  assert.match(result.draft, /#4199: Resolved incident 4199/);
  assert.equal(result.reviewed, 1);
});

test("Laya does not place tentative or incomplete guesses in the output template", async () => {
  for (const complete of [true, false]) {
    const result = await runIncidentDraft({
      adapter: createAdapter({
        currentIncident: { sourceIp: "192.0.2.12", alertJson: [{ opaque: "203.0.113.77" }], alertJsonComplete: true },
        searchTicketIds: ["4200"]
      }),
      settings,
      mapIncident: async () => ({
        fields: { sourceIp: "203.0.113.77" },
        statuses: { sourceIp: complete ? "tentative" : "selected" },
        complete, sourceComplete: true, processingComplete: complete,
        warning: complete ? "Tentative best guess." : "Model processing incomplete."
      })
    });
    assert.match(result.draft, /Source: 192\.0\.2\.12/);
    assert.doesNotMatch(result.draft, /Source: 203\.0\.113\.77/);
    assert.equal(result.layaMapped, false);
    assert.deepEqual(result.layaFields, []);
    assert.deepEqual(result.layaTentativeFields, complete ? ["sourceIp"] : []);
    assert.match(result.warning, complete ? /Tentative/ : /configured source-field mappings were used/);
  }
});
