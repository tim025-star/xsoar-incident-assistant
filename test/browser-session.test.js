import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  BrowserSessionManager,
  readDevToolsWebSocketEndpoint
} from "../src/browser-session.js";
import { resolveAppConfig } from "../src/config.js";

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

test("current Chrome mode connects to normal Chrome and disconnects without closing its context", async () => {
  const context = { pages: () => [] };
  let disconnectedHandler;
  let browserCloseCalls = 0;
  let launched = false;
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
    },
    launchPersistentContext: async () => {
      launched = true;
      throw new Error("current Chrome mode must not launch another browser");
    }
  };
  const manager = new BrowserSessionManager({
    chromiumApi,
    currentChromeEndpoint: async () => "ws://127.0.0.1:43127/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"
  });
  const config = resolveAppConfig({
    session: { mode: "current", browser: "chrome" },
    xsoar: { allowedOrigin: "https://xsoar.example.test" }
  });

  assert.equal(await manager.start(config), context);
  assert.deepEqual(manager.status(), { running: true, mode: "current" });
  assert.equal(launched, false);

  await manager.stop();
  assert.equal(browserCloseCalls, 1);
  assert.deepEqual(manager.status(), { running: false, mode: null });
  disconnectedHandler?.();
  assert.deepEqual(manager.status(), { running: false, mode: null });
});
