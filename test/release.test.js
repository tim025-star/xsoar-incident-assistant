import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { DEFAULT_APP_CONFIG, resolveAppConfig } from "../src/config.js";
import { createAssistantServer } from "../src/server.js";
import { isSupportedNodeVersion } from "../scripts/check-node-version.mjs";

const execFileAsync = promisify(execFile);

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
function deferred() { let resolve; const promise = new Promise((next) => { resolve = next; }); return { promise, resolve }; }

test("current Chrome is the only browser interface", () => {
  assert.equal(DEFAULT_APP_CONFIG.configVersion, 10);
  assert.equal("session" in DEFAULT_APP_CONFIG, false);
  assert.equal(DEFAULT_APP_CONFIG.xsoar.template.analystName, "");
  assert.deepEqual(DEFAULT_APP_CONFIG.localAi, { enabled: false, model: "qwen3.5:9b" });
});

test("XSOAR settings persist without browser-mode settings", async () => {
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
    const saved = await client.config.save({ ...stored, xsoar: { ...stored.xsoar, lookbackQuery: "status:closed" } });
    assert.equal(saved.xsoar.lookbackQuery, "status:closed");
    assert.equal("session" in saved, false);
    assert.deepEqual((await client.status()).session, { running: false });
  } finally {
    await closeServer(app.server);
  }
});

test("the published Windows installer is per-user, self-contained, and releases without signing credentials", async () => {
  const root = new URL("../", import.meta.url);
  const [installer, launcher, packager, runtimeDownloader, ollamaInstaller, releaseWorkflow, ciWorkflow] = await Promise.all([
    readFile(new URL("installer/XSOARIncidentAssistant.iss", root), "utf8"),
    readFile(new URL("installer/launcher.vbs", root), "utf8"),
    readFile(new URL("scripts/package-windows.mjs", root), "utf8"),
    readFile(new URL("installer/download-node-runtime.ps1", root), "utf8"),
    readFile(new URL("installer/install-ollama.ps1", root), "utf8"),
    readFile(new URL(".github/workflows/release.yml", root), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8")
  ]);

  assert.match(installer, /^PrivilegesRequired=lowest$/m);
  assert.match(installer, /^DefaultDirName=\{localappdata\}\\Programs\\\{#AppName\}$/m);
  assert.match(installer, /^AppId=\{\{60EBD23D-706E-4D31-AC14-431621E99316\}$/m);
  assert.match(installer, /^ArchitecturesAllowed=x64$/m);
  assert.match(installer, /^Source: "\{#StageDir\}\\\*"; DestDir: "\{app\}"; Flags: recursesubdirs createallsubdirs$/m);
  assert.match(installer, /^Name: "\{autodesktop\}\\\{#AppName\}";.*Tasks: desktopicon$/m);
  assert.match(installer, /^Name: "installollama";.*Flags: unchecked$/m);
  assert.match(installer, /OllamaVersion "0\.34\.0"/);
  assert.match(launcher, /runtime\\node\.exe/);
  assert.doesNotMatch(launcher, /npm(?:\.cmd)?/i);
  assert.match(packager, /npmCliPath, "ci", "--omit=dev", "--ignore-scripts"/);
  assert.match(packager, /Portable Node\.js runtime/);
  assert.match(packager, /OLLAMA_VERSION must be an exact WinGet package version/);
  assert.doesNotMatch(packager, /keyboard-trigger\.(?:ps1|exe)/);
  assert.match(runtimeDownloader, /dist\/v24\.14\.0\/win-x64\/node\.exe/);
  assert.match(runtimeDownloader, /63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088/);
  assert.ok(ollamaInstaller.indexOf("Get-Command ollama.exe") < ollamaInstaller.indexOf("Get-Command winget.exe"));
  assert.match(ollamaInstaller, /if \(\[version\]\$Matches\[1\] -ge \[version\]\$Version\) \{ \$installAction = \$null \}/);
  assert.match(ollamaInstaller, /\$installAction = "upgrade"/);
  assert.match(ollamaInstaller, /if \(\$installAction\) \{\s+\$winget = Get-Command winget\.exe/s);
  assert.match(ollamaInstaller, /& \$ollama pull qwen3\.5:9b/);
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

test("legacy settings migrate by discarding retired fields", () => {
  const migrated = resolveAppConfig({
    configVersion: 8,
    session: {
      mode: "managed",
      browser: "edge",
      activationHotkey: { label: "Ctrl + K", modifiers: 2, code: "KeyK" },
      profileDirectory: "C:\\Legacy Browser Profile"
    },
    xsoar: {
      fieldLabels: {
        customerShortName: ["Customer Short Name"],
        owner: ["Owner"],
        phase: ["Phase"],
        description: ["Description"]
      },
      template: { analystName: "" }
    }
  }, { requireTenant: false });
  assert.equal(migrated.configVersion, 10);
  assert.equal("session" in migrated, false);
  for (const key of ["customerShortName", "owner", "phase", "description"]) {
    assert.equal(key in migrated.xsoar.fieldLabels, false);
  }
  assert.deepEqual(migrated.localAi, { enabled: false, model: "qwen3.5:9b" });
});

test("cloud aliases cannot be saved as local AI models", () => {
  assert.throws(
    () => resolveAppConfig({ localAi: { enabled: true, model: "qwen3.5:cloud" } }, { requireTenant: false }),
    /Cloud and remote model aliases/
  );
});

test("shared operation locking and draft versions survive identical AI draft text", async () => {
  const stored = resolveAppConfig({ xsoar: { allowedOrigin: "https://xsoar.example.test" }, localAi: { enabled: true, model: "qwen3.5:9b" } });
  const draftStarted = deferred();
  const draftDone = deferred();
  const pullStarted = deferred();
  const pullDone = deferred();
  const app = createAssistantServer({
    token: "operation-token",
    routerOptions: {
      sessions: { status: () => ({ running: false }), start: async () => {}, adapter: () => ({}) },
      configStore: { load: async () => stored, save: async () => stored },
      generateDraft: async () => { draftStarted.resolve(); await draftDone.promise; return { draft: "same AI draft", reviewed: 0, aiEnriched: true }; },
      localAi: {
        status: async () => ({ available: true, models: ["qwen3.5:9b"], detail: "ready" }),
        pull: async () => { pullStarted.resolve(); await pullDone.promise; return ["qwen3.5:9b"]; },
        enrich: async () => ({})
      }
    }
  });
  const origin = new URL(await app.listen(0)).origin;
  const client = createORPCClient(new RPCLink({ url: `${origin}/rpc`, headers: { "X-Assistant-Token": "operation-token", Origin: origin } }));
  try {
    const first = client.draft.generate();
    await draftStarted.promise;
    await assert.rejects(() => client.localAi.pull({ model: "qwen3.5:9b" }), /Cannot start model download while draft generation is running/);
    draftDone.resolve();
    const firstResult = await first;
    const secondResult = await client.draft.generate();
    assert.equal(firstResult.draft, secondResult.draft);
    assert.equal(firstResult.draftVersion, 1);
    assert.equal(secondResult.draftVersion, 2);
    const pull = client.localAi.pull({ model: "qwen3.5:9b" });
    await pullStarted.promise;
    await assert.rejects(() => client.draft.generate(), /Cannot start draft generation while model download is running/);
    pullDone.resolve();
    await pull;
  } finally { await closeServer(app.server); }
});

test("runtime version check matches the Vite-supported Node ranges", () => {
  for (const version of ["20.19.0", "20.20.1", "22.12.0", "23.0.0", "24.1.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, `${version} should be accepted`);
  }
  for (const version of ["20.18.9", "21.7.3", "22.0.0", "22.11.9", "invalid"]) {
    assert.equal(isSupportedNodeVersion(version), false, `${version} should be rejected`);
  }
});

test("config migration rejects future versions and retired fields in current configs", () => {
  assert.throws(
    () => resolveAppConfig({ configVersion: 999 }, { requireTenant: false }),
    /configVersion/
  );
  assert.throws(
    () => resolveAppConfig({
      configVersion: 9,
      xsoar: { fieldLabels: { owner: ["Owner"] } }
    }, { requireTenant: false }),
    /fieldLabels\.owner/
  );
});

test("public runtime and documentation contain no extension, legacy remote-port launcher, or organisation-specific implementation", async () => {
  const root = new URL("../", import.meta.url);
  const rootPath = fileURLToPath(root);
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: rootPath, encoding: "utf8" });
  const files = stdout.split("\0").filter((file) => file && !file.endsWith("release.test.js"));
  const publicText = (await Promise.all(files.map((file) => readFile(path.join(rootPath, file), "utf8")))).join("\n").toLowerCase();
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
    "launchpersistentcontext",
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
    assert.match(authorised.detail, /Configure the assistant/);
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
