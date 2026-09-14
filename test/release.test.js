import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest uses MV3 with narrowly scoped capabilities and no credential APIs", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "scripting", "sidePanel", "storage"].sort());
  for (const forbidden of ["cookies", "debugger", "nativeMessaging", "webRequest", "webRequestBlocking"]) {
    assert.ok(!manifest.permissions.includes(forbidden), `${forbidden} must not be requested`);
  }
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
});

test("public defaults contain no environment-specific placeholders", async () => {
  const files = [
    "../extension/domain.js",
    "../extension/options.html",
    "../extension/sidepanel.html",
    "../README.md",
    "../SECURITY.md"
  ];
  const publicText = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8"))))
    .join("\n")
    .toLowerCase();
  for (const forbidden of ["corp.local", "internal.example", "example employee"]) {
    assert.ok(!publicText.includes(forbidden), `public files must not contain ${forbidden}`);
  }
});
