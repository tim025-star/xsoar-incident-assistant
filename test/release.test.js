import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { DEFAULT_APP_CONFIG, resolveAppConfig } from "../src/config.js";
import { createAssistantServer } from "../src/server.js";
import { isSupportedNodeVersion } from "../scripts/check-node-version.mjs";

test("managed mode is the public default and the analyst identity is empty", () => {
  assert.equal(DEFAULT_APP_CONFIG.session.mode, "managed");
  assert.equal(DEFAULT_APP_CONFIG.session.browser, "edge");
  assert.equal(DEFAULT_APP_CONFIG.xsoar.template.analystName, "");
});

test("runtime version check matches the Vite-supported Node ranges", () => {
  for (const version of ["20.19.0", "20.20.1", "22.12.0", "23.0.0", "24.1.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, `${version} should be accepted`);
  }
  for (const version of ["20.18.9", "21.7.3", "22.0.0", "22.11.9", "invalid"]) {
    assert.equal(isSupportedNodeVersion(version), false, `${version} should be rejected`);
  }
});

test("legacy cdp settings migrate to diagnostics and endpoints remain unsupported", () => {
  const migrated = resolveAppConfig({ configVersion: 3, session: { mode: "cdp" } }, { requireTenant: false });
  assert.equal(migrated.configVersion, 4);
  assert.equal(migrated.session.mode, "diagnostics");
  assert.ok(migrated.session.profileDirectory.endsWith("browser-profile-debug"));
  assert.equal(resolveAppConfig({ session: { mode: "diagnostics" } }, { requireTenant: false }).session.mode, "diagnostics");
  assert.throws(
    () => resolveAppConfig({ configVersion: 4, session: { mode: "cdp" } }, { requireTenant: false }),
    /managed or diagnostics/
  );
  assert.throws(
    () => resolveAppConfig({ session: { mode: "cdp", cdpEndpoint: "http://127.0.0.1:9222" } }, { requireTenant: false }),
    /Unrecognized key/
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
    "manifest v3",
    "connectovercdp",
    "--remote-debugging-port",
    "/api/debug/launch"
  ];
  for (const forbidden of forbiddenValues) {
    assert.ok(!publicText.includes(forbidden), `public files must not contain ${forbidden}`);
  }
});

test("local oRPC API requires the process token and exact origin", async () => {
  const app = createAssistantServer({ token: "test-token" });
  const launchUrl = new URL(await app.listen(0));
  const origin = launchUrl.origin;
  try {
    assert.equal((await fetch(`${origin}/rpc/status`, { method: "POST" })).status, 403);
    const client = createORPCClient(new RPCLink({
      url: `${origin}/rpc`,
      headers: { "X-Assistant-Token": "test-token", Origin: origin }
    }));
    const authorised = await client.status();
    assert.equal(authorised.phase, "idle");
    const invalidHostStatus = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: launchUrl.hostname,
        port: launchUrl.port,
        path: "/rpc/status",
        method: "POST",
        headers: { Host: "attacker.example", Origin: origin, "X-Assistant-Token": "test-token" }
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.once("error", reject);
      request.end();
    });
    assert.equal(invalidHostStatus, 403);
    const crossOrigin = await fetch(`${origin}/rpc/browser/stop`, {
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

test("Numpad+ trigger is separately authenticated and uses the same draft workflow", async () => {
  let generated = 0;
  const config = resolveAppConfig({ xsoar: { allowedOrigin: "https://xsoar.example.test" } });
  const sessions = {
    status: () => ({ running: true, mode: "managed" }),
    start: async () => {},
    adapter: () => ({})
  };
  const app = createAssistantServer({
    token: "page-token",
    hotkeyToken: "keyboard-token",
    routerOptions: {
      sessions,
      configStore: { load: async () => config, save: async () => config },
      generateDraft: async () => {
        generated += 1;
        return { draft: "Keyboard draft", reviewed: 0, warning: "" };
      }
    }
  });
  const origin = new URL(await app.listen(0)).origin;
  try {
    assert.equal((await fetch(`${origin}/internal/keyboard-trigger`, { method: "POST" })).status, 403);
    const response = await fetch(`${origin}/internal/keyboard-trigger`, {
      method: "POST",
      headers: { "X-Assistant-Hotkey-Token": "keyboard-token" }
    });
    assert.equal(response.status, 204);
    assert.equal(generated, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
