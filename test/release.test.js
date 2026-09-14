import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";

import { DEFAULT_APP_CONFIG, resolveAppConfig } from "../src/config.js";
import { createAssistantServer } from "../src/server.js";

test("managed mode is the public default and the analyst identity is empty", () => {
  assert.equal(DEFAULT_APP_CONFIG.session.mode, "managed");
  assert.equal(DEFAULT_APP_CONFIG.session.browser, "edge");
  assert.equal(DEFAULT_APP_CONFIG.xsoar.template.analystName, "");
});

test("debug endpoints cannot be supplied through configuration", () => {
  assert.throws(
    () => resolveAppConfig({ session: { mode: "cdp", cdpEndpoint: "http://127.0.0.1:9222" } }, { requireTenant: false }),
    /Unsupported session field/
  );
});

test("normal Chrome and Edge profile trees cannot be selected", () => {
  const local = process.env.LOCALAPPDATA || "C:\\Users\\Public\\AppData\\Local";
  for (const profile of [path.join(local, "Google", "Chrome", "User Data"), path.join(local, "Microsoft", "Edge", "User Data", "Default")]) {
    assert.throws(() => resolveAppConfig({ session: { profileDirectory: profile } }, { requireTenant: false }), /normal Chrome or Edge/);
  }
});

test("browser profiles stay inside the assistant application-data directory", () => {
  assert.throws(
    () => resolveAppConfig({ session: { profileDirectory: path.resolve("C:\\Users\\Public\\assistant-profile") } }, { requireTenant: false }),
    /application-data directory/
  );
});

test("public runtime and documentation contain no extension or organisation-specific implementation", async () => {
  const root = new URL("../", import.meta.url);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== ".git" && !entry.parentPath.includes("node_modules") && !entry.parentPath.includes(".git"))
    .filter((entry) => !entry.name.endsWith("release.test.js"));
  const publicText = (await Promise.all(files.map((entry) => readFile(path.join(entry.parentPath, entry.name), "utf8")))).join("\n").toLowerCase();
  const forbiddenValues = [
    ["tel", "stra"].join(""),
    ["tim", "025"].join(""),
    ["not", "_tambok"].join(""),
    "corp.local",
    "internal.example",
    "example employee",
    "chrome.storage",
    "manifest v3"
  ];
  for (const forbidden of forbiddenValues) {
    assert.ok(!publicText.includes(forbidden), `public files must not contain ${forbidden}`);
  }
});

test("local API requires the process token and exact origin", async () => {
  const app = createAssistantServer({ token: "test-token" });
  const launchUrl = new URL(await app.listen(0));
  const origin = launchUrl.origin;
  try {
    assert.equal((await fetch(`${origin}/api/status`)).status, 403);
    const authorised = await fetch(`${origin}/api/status`, { headers: { "X-Assistant-Token": "test-token" } });
    assert.equal(authorised.status, 200);
    const invalidHostStatus = await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: launchUrl.hostname,
        port: launchUrl.port,
        path: "/api/status",
        headers: { Host: "attacker.example", "X-Assistant-Token": "test-token" }
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.once("error", reject);
    });
    assert.equal(invalidHostStatus, 403);
    const crossOrigin = await fetch(`${origin}/api/browser/stop`, {
      method: "POST",
      headers: { "X-Assistant-Token": "test-token", Origin: "https://attacker.example" }
    });
    assert.equal(crossOrigin.status, 403);
    const page = await fetch(origin);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
