import test from "node:test";
import assert from "node:assert/strict";

import { extractSearchResultsFromPage } from "../src/page-adapter.js";

test("search extraction discards queue rows rendered before the filter finishes loading", async () => {
  const original = {
    document: globalThis.document,
    location: globalThis.location,
    window: globalThis.window
  };
  const started = Date.now();
  const visible = { offsetWidth: 1, offsetHeight: 1, getClientRects: () => [1] };
  const link = (ticketId) => ({
    ...visible,
    getAttribute: () => `/incident/${ticketId}`
  });
  const root = {
    ...visible,
    clientHeight: 500,
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [link(Date.now() - started < 75 ? "9001" : "4199")];
      if (selector.includes("aria-busy")) return Date.now() - started < 75 ? [{ ...visible }] : [];
      return [];
    }
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents?query=expected");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: root,
    querySelector(selector) {
      if (selector === "[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page") return root;
      if (selector === ".table-paging-message") return { textContent: "1-1 of 1" };
      return null;
    },
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      maxResults: 5,
      timeoutMs: 2000
    });
    assert.deepEqual(result.ticketIds, ["4199"]);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});
