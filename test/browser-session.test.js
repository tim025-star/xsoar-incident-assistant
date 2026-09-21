import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  BrowserSessionManager,
  readDevToolsWebSocketEndpoint,
  submitHistoricSearch
} from "../src/browser-session.js";
import { resolveSettings } from "../src/domain.js";

test("reads only a loopback browser WebSocket endpoint from Chrome's approval file", async (t) => {
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "xsoar-current-chrome-"));
  t.after(() => rm(userDataDirectory, { recursive: true, force: true }));
  const portFile = path.join(userDataDirectory, "DevToolsActivePort");

  await writeFile(portFile, "43127\n/devtools/browser/01234567-89ab-cdef-0123-456789abcdef\n");
  assert.equal(
    await readDevToolsWebSocketEndpoint(userDataDirectory),
    "ws://127.0.0.1:43127/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"
  );

  await writeFile(portFile, "43127\n/devtools/page/not-a-browser\n");
  await assert.rejects(readDevToolsWebSocketEndpoint(userDataDirectory), /valid browser endpoint/);
});

test("connects to normal Chrome and disconnects without closing its context", async () => {
  const context = { pages: () => [] };
  let disconnectedHandler;
  let browserCloseCalls = 0;
  const browser = {
    contexts: () => [context],
    once: (event, handler) => {
      assert.equal(event, "disconnected");
      disconnectedHandler = handler;
    },
    close: async () => { browserCloseCalls += 1; }
  };
  const chromiumApi = {
    connectOverCDP: async (endpoint) => {
      assert.equal(endpoint, "ws://127.0.0.1:43127/devtools/browser/01234567-89ab-cdef-0123-456789abcdef");
      return browser;
    }
  };
  const manager = new BrowserSessionManager({
    chromiumApi,
    currentChromeEndpoint: async () => "ws://127.0.0.1:43127/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"
  });
  assert.equal(await manager.start(), context);
  assert.deepEqual(manager.status(), { running: true });

  await manager.stop();
  assert.equal(browserCloseCalls, 1);
  assert.deepEqual(manager.status(), { running: false });
  disconnectedHandler?.();
  assert.deepEqual(manager.status(), { running: false });
});

test("opens Chrome's approved remote-debugging setup in the normal browser", () => {
  let openedUrl = "";
  const manager = new BrowserSessionManager({ openChromePage: (url) => { openedUrl = url; } });
  manager.openSetup();
  assert.equal(openedUrl, "chrome://inspect/#remote-debugging");
});

test("focuses an existing local console or reopens it when the tab was closed", async () => {
  let pages = [];
  let existingFocusCalls = 0;
  let openedUrl = "";
  let openedFocusCalls = 0;
  const existingPage = {
    url: () => "http://127.0.0.1:43128/",
    evaluate: async (callback, token) => {
      assert.equal(typeof callback, "function");
      assert.equal(token, "session-token");
      return true;
    },
    bringToFront: async () => { existingFocusCalls += 1; }
  };
  const openedPage = {
    goto: async (url) => { openedUrl = url; },
    bringToFront: async () => { openedFocusCalls += 1; },
    close: async () => {}
  };
  const context = { pages: () => pages, newPage: async () => openedPage };
  const browser = { contexts: () => [context], once: () => {}, close: async () => {} };
  const manager = new BrowserSessionManager({
    chromiumApi: { connectOverCDP: async () => browser },
    currentChromeEndpoint: async () => "ws://127.0.0.1:43127/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"
  });
  manager.setConsoleUrl("http://127.0.0.1:43128/#session-token");
  assert.throws(() => manager.setConsoleUrl("https://attacker.example/#session-token"), /loopback home page/);
  manager.setConsoleUrl("http://127.0.0.1:43128/#session-token");
  await manager.start();

  pages = [existingPage];
  assert.equal(await manager.showConsole(), true);
  assert.equal(existingFocusCalls, 1);
  assert.equal(openedUrl, "");

  pages = [];
  assert.equal(await manager.showConsole(), true);
  assert.equal(openedUrl, "http://127.0.0.1:43128/#session-token");
  assert.equal(openedFocusCalls, 1);
});

test("closes a temporary tab when its initial navigation fails", async () => {
  let closed = false;
  const page = {
    route: async () => {},
    goto: async () => { throw new Error("navigation failed"); },
    close: async () => { closed = true; }
  };
  const context = { pages: () => [], newPage: async () => page };
  const browser = {
    contexts: () => [context],
    once: () => {},
    close: async () => {}
  };
  const manager = new BrowserSessionManager({
    chromiumApi: { connectOverCDP: async () => browser },
    currentChromeEndpoint: async () => "ws://127.0.0.1:43127/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"
  });
  await manager.start();
  const adapter = manager.adapter(resolveSettings({ allowedOrigin: "https://xsoar.example.test" }));

  await assert.rejects(() => adapter.openTab("https://xsoar.example.test/Custom/GenericLayout/4200"), /navigation failed/);
  assert.equal(closed, true);
});

test("submits historic queries through the visible XSOAR incidents query bar", async () => {
  const calls = [];
  const input = {
    fill: async (value) => calls.push(["fill", value]),
    press: async (key) => calls.push(["press", key])
  };
  let waitCalls = 0;
  const page = {
    url: () => "https://xsoar.example.test/incidents",
    evaluate: async (_callback, argument) => calls.push(["evaluate", argument]),
    waitForFunction: async (callback, argument, options) => {
      calls.push(["waitForFunction", argument, options]);
      assert.equal(typeof callback, "function");
      waitCalls += 1;
      return waitCalls === 1 ? { asElement: () => input } : undefined;
    }
  };

  await submitHistoricSearch(page, {
    expectedOrigin: "https://xsoar.example.test",
    expectedPath: "/incidents",
    expectedQuery: 'rawName:"Example Rule" and rawType:"Endpoint"',
    queryParameter: "query",
    timeoutMs: 20000
  });

  assert.deepEqual(calls, [
    ["waitForFunction", undefined, { timeout: 20000 }],
    ["fill", 'rawName:"Example Rule" and rawType:"Endpoint"'],
    ["evaluate", { observationKey: "__xsoarIncidentAssistantHistoricSearch" }],
    ["press", "Enter"],
    ["waitForFunction", {
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      expectedQuery: 'rawName:"Example Rule" and rawType:"Endpoint"',
      observationKey: "__xsoarIncidentAssistantHistoricSearch",
      queryBar: input
    }, { timeout: 20000 }],
    ["evaluate", { observationKey: "__xsoarIncidentAssistantHistoricSearch" }]
  ]);
});

test("extracts historic results when XSOAR keeps the accepted query out of the URL", async () => {
  const input = {
    isConnected: true,
    value: "",
    fill: async (value) => { input.value = value; },
    press: async () => {}
  };
  let waitCalls = 0;
  let extractionOptions;
  const page = {
    url: () => "https://xsoar.example.test/incidents",
    waitForFunction: async () => {
      waitCalls += 1;
      return waitCalls === 1 ? { asElement: () => input } : undefined;
    },
    evaluate: async (_callback, argument) => {
      if (argument?.incidentUrlPattern) {
        extractionOptions = argument;
        return { ticketIds: ["4199"], truncated: false };
      }
      return undefined;
    }
  };
  const context = { pages: () => [] };
  const browser = { contexts: () => [context], once: () => {}, close: async () => {} };
  const manager = new BrowserSessionManager({
    chromiumApi: { connectOverCDP: async () => browser },
    currentChromeEndpoint: async () => "ws://127.0.0.1:43127/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"
  });
  await manager.start();
  const adapter = manager.adapter(resolveSettings({ allowedOrigin: "https://xsoar.example.test" }));

  const result = await adapter.extractSearchResults(page, {
    expectedQuery: 'rawName:"Example Rule" and rawType:"Endpoint"',
    maxResults: 5,
    timeoutMs: 1000
  });

  assert.deepEqual(result, { ticketIds: ["4199"], truncated: false });
  assert.equal(extractionOptions.expectedPath, "/incidents");
});

test("historic search validates the incidents path before touching the search input", async () => {
  let locatorCalls = 0;
  const page = {
    url: () => "https://xsoar.example.test/other-page",
    locator: () => { locatorCalls += 1; },
    waitForFunction: async () => {}
  };

  await assert.rejects(() => submitHistoricSearch(page, {
    expectedOrigin: "https://xsoar.example.test",
    expectedPath: "/incidents",
    expectedQuery: "expected",
    queryParameter: "query",
    timeoutMs: 1000
  }), /incidents page/);
  assert.equal(locatorCalls, 0);
});
