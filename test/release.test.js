import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { DEFAULT_APP_CONFIG, resolveAppConfig } from "../src/config.js";
import { createAssistantServer } from "../src/server.js";
import { isSupportedNodeVersion } from "../scripts/check-node-version.mjs";

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test("current Chrome mode is the default, with the legacy managed profile retained as fallback", () => {
  assert.equal(DEFAULT_APP_CONFIG.session.mode, "current");
  assert.equal(DEFAULT_APP_CONFIG.session.browser, "chrome");
  assert.equal(
    DEFAULT_APP_CONFIG.session.profileDirectory,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "TSOC-Copilot")
  );
  assert.deepEqual(DEFAULT_APP_CONFIG.session.activationHotkey, { label: "Numpad +", modifiers: 0, code: "NumpadAdd" });
  assert.equal(DEFAULT_APP_CONFIG.xsoar.template.analystName, "");
  assert.throws(
    () => resolveAppConfig({ session: { mode: "current", browser: "edge" } }, { requireTenant: false }),
    /requires Google Chrome/
  );
});
test("activation shortcuts are validated before being saved", () => {
  assert.deepEqual(
    resolveAppConfig({ session: { activationHotkey: "ctrl_shift_g" } }, { requireTenant: false }).session.activationHotkey,
    { label: "Ctrl + Shift + G", modifiers: 6, code: "KeyG" }
  );
  assert.deepEqual(
    resolveAppConfig({ session: { activationHotkey: { label: "Ctrl + F12", modifiers: 2, code: "F12" } } }, { requireTenant: false }).session.activationHotkey,
    { label: "Ctrl + F12", modifiers: 2, code: "F12" }
  );
  assert.throws(
    () => resolveAppConfig({ session: { activationHotkey: "ctrl_alt_delete" } }, { requireTenant: false }),
    /Activation hotkey/
  );
});

test("settings persist without an external activation-shortcut helper", async () => {
  let stored = resolveAppConfig({ xsoar: { allowedOrigin: "https://xsoar.example.test" } });
  const configStore = {
    load: async () => stored,
    save: async (input, options) => {
      stored = resolveAppConfig(input, options);
      return stored;
    }
  };
  const app = createAssistantServer({
    token: "settings-test-token",
    routerOptions: { configStore }
  });
  const origin = new URL(await app.listen(0)).origin;
  const client = createORPCClient(new RPCLink({
    url: `${origin}/rpc`,
    headers: { "X-Assistant-Token": "settings-test-token", Origin: origin }
  }));
  try {
    const saved = await client.config.save({
      ...stored,
      session: { ...stored.session, browser: "chrome" }
    });
    assert.equal(saved.session.browser, "chrome");
    assert.equal(stored.session.browser, "chrome");
    assert.deepEqual((await client.status()).hotkey, { active: false, error: "" });
  } finally {
    await closeServer(app.server);
  }
});

test("detected browser profiles can be imported and selected through the local API", async () => {
  let stored = resolveAppConfig({ xsoar: { allowedOrigin: "https://xsoar.example.test" } });
  const configStore = {
    load: async () => stored,
    save: async (input, options) => {
      stored = resolveAppConfig(input, options);
      return stored;
    }
  };
  const detected = {
    id: "chrome:Default",
    browser: "chrome",
    browserName: "Google Chrome",
    directoryName: "Default",
    name: "Default profile",
    isDefault: true
  };
  const profileStore = {
    list: async () => [detected],
    import: async (id) => {
      assert.equal(id, detected.id);
      return {
        browser: "chrome",
        profileDirectory: path.join(DEFAULT_APP_CONFIG.session.profileDirectory, "..", "imported-chrome-default"),
        reused: false
      };
    }
  };
  const app = createAssistantServer({
    token: "profile-import-test-token",
    routerOptions: { configStore, profileStore }
  });
  const origin = new URL(await app.listen(0)).origin;
  const client = createORPCClient(new RPCLink({
    url: `${origin}/rpc`,
    headers: { "X-Assistant-Token": "profile-import-test-token", Origin: origin }
  }));
  try {
    assert.deepEqual(await client.browser.profiles(), [detected]);
    const imported = await client.browser.importProfile({ id: detected.id });
    assert.equal(imported.session.browser, "chrome");
    assert.ok(imported.session.profileDirectory.endsWith("imported-chrome-default"));
    assert.equal(stored.session.profileDirectory, imported.session.profileDirectory);
  } finally {
    await closeServer(app.server);
  }
});

test("the focused-browser shortcut invokes the same draft workflow", async () => {
  const config = resolveAppConfig({ xsoar: { allowedOrigin: "https://xsoar.example.test" } });
  let running = false;
  let shortcutHandler;
  let generated = 0;
  const sessions = {
    status: () => ({ running, mode: running ? "managed" : null }),
    start: async (_config, options) => {
      running = true;
      shortcutHandler = options.onActivationShortcut;
    },
    adapter: () => ({}),
    stop: async () => { running = false; }
  };
  const app = createAssistantServer({
    token: "browser-shortcut-test-token",
    routerOptions: {
      sessions,
      configStore: { load: async () => config, save: async () => config },
      generateDraft: async () => {
        generated += 1;
        return { draft: "Browser shortcut draft", reviewed: 0, warning: "" };
      }
    }
  });
  const origin = new URL(await app.listen(0)).origin;
  const client = createORPCClient(new RPCLink({
    url: `${origin}/rpc`,
    headers: { "X-Assistant-Token": "browser-shortcut-test-token", Origin: origin }
  }));
  try {
    await client.browser.open();
    await shortcutHandler();
    assert.equal(generated, 1);
    assert.equal((await client.status()).draft, "Browser shortcut draft");
  } finally {
    await closeServer(app.server);
  }
});

test("runtime version check matches the Vite-supported Node ranges", () => {
  for (const version of ["20.19.0", "20.20.1", "22.12.0", "23.0.0", "24.1.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, `${version} should be accepted`);
  }
  for (const version of ["20.18.9", "21.7.3", "22.0.0", "22.11.9", "invalid"]) {
    assert.equal(isSupportedNodeVersion(version), false, `${version} should be rejected`);
  }
});

test("the published Windows installer is per-user, self-contained, and releases without signing credentials", async () => {
  const root = new URL("../", import.meta.url);
  const [installer, launcher, packager, runtimeDownloader, releaseWorkflow, ciWorkflow] = await Promise.all([
    readFile(new URL("installer/XSOARIncidentAssistant.iss", root), "utf8"),
    readFile(new URL("installer/launcher.vbs", root), "utf8"),
    readFile(new URL("scripts/package-windows.mjs", root), "utf8"),
    readFile(new URL("installer/download-node-runtime.ps1", root), "utf8"),
    readFile(new URL(".github/workflows/release.yml", root), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8")
  ]);

  assert.match(installer, /^PrivilegesRequired=lowest$/m);
  assert.match(installer, /^DefaultDirName=\{localappdata\}\\Programs\\\{#AppName\}$/m);
  assert.match(installer, /^AppId=\{\{60EBD23D-706E-4D31-AC14-431621E99316\}$/m);
  assert.match(installer, /^ArchitecturesAllowed=x64$/m);
  assert.match(installer, /^Source: "\{#StageDir\}\\\*"; DestDir: "\{app\}"; Flags: recursesubdirs createallsubdirs$/m);
  assert.match(launcher, /runtime\\node\.exe/);
  assert.doesNotMatch(launcher, /npm(?:\.cmd)?/i);
  assert.match(packager, /npmCliPath, "ci", "--omit=dev", "--ignore-scripts"/);
  assert.match(packager, /Portable Node\.js runtime/);
  assert.doesNotMatch(packager, /keyboard-trigger\.(?:ps1|exe)/);
  assert.match(runtimeDownloader, /dist\/v24\.14\.0\/win-x64\/node\.exe/);
  assert.match(runtimeDownloader, /63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088/);
  assert.match(releaseWorkflow, /download-node-runtime\.ps1/);
  assert.match(releaseWorkflow, /choco install innosetup --version=6\.7\.1/);
  assert.doesNotMatch(releaseWorkflow, /WINDOWS_SIGNING_CERTIFICATE_BASE64/);
  assert.doesNotMatch(releaseWorkflow, /signtool\.FullName verify \/pa \/v/);
  assert.doesNotMatch(releaseWorkflow, /environment: windows-release/);
  assert.match(releaseWorkflow, /git merge-base --is-ancestor \$env:GITHUB_SHA origin\/main/);
  assert.match(releaseWorkflow, /The release tag must be v\$version\./);
  assert.match(releaseWorkflow, /Write installer checksum/);
  assert.match(releaseWorkflow, /gh release create/);
  assert.match(ciWorkflow, /windows-installer:/);
  assert.match(ciWorkflow, /npm run package:windows/);
});

test("legacy custom cdp settings migrate to diagnostics and configurable endpoints remain unsupported", () => {
  const migrated = resolveAppConfig({ configVersion: 3, session: { mode: "cdp" } }, { requireTenant: false });
  assert.equal(migrated.configVersion, 7);
  assert.equal(migrated.session.mode, "diagnostics");
  assert.ok(migrated.session.profileDirectory.endsWith("browser-profile-debug"));
  assert.equal(resolveAppConfig({ session: { mode: "diagnostics" } }, { requireTenant: false }).session.mode, "diagnostics");
  assert.throws(
    () => resolveAppConfig({ configVersion: 4, session: { mode: "cdp" } }, { requireTenant: false }),
    /current, managed, or diagnostics/
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

test("a custom dedicated Chromium user-data directory can be selected", () => {
  const customProfile = path.resolve("C:\\Browser Profiles\\XSOAR Dedicated");
  assert.equal(
    resolveAppConfig({ session: { profileDirectory: customProfile } }, { requireTenant: false }).session.profileDirectory,
    customProfile
  );
});

test("public runtime and documentation contain no extension, legacy remote-port launcher, or organisation-specific implementation", async () => {
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
    await closeServer(app.server);
  }
});
