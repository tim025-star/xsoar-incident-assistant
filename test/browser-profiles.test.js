import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";

import {
  detectBrowserProfiles,
  importBrowserProfile,
  prepareBrowserProfileDirectory
} from "../src/browser-profiles.js";

async function createChromeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xsoar-browser-profiles-"));
  const localAppData = path.join(root, "LocalAppData");
  const appDataDirectory = path.join(localAppData, "XSOAR Incident Assistant");
  const userDataDirectory = path.join(localAppData, "Google", "Chrome", "User Data");
  const defaultProfile = path.join(userDataDirectory, "Default");
  const otherProfile = path.join(userDataDirectory, "Profile 1");
  await Promise.all([
    mkdir(path.join(defaultProfile, "Network"), { recursive: true }),
    mkdir(path.join(defaultProfile, "Local Storage"), { recursive: true }),
    mkdir(otherProfile, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(userDataDirectory, "Local State"), JSON.stringify({
      os_crypt: { encrypted_key: "synthetic-key" },
      profile: {
        last_used: "Profile 1",
        info_cache: {
          Default: { name: "Default profile" },
          "Profile 1": { name: "Work profile" },
          "Guest Profile": { name: "Guest" }
        }
      }
    })),
    writeFile(path.join(defaultProfile, "Network", "Cookies"), "synthetic-cookie-store"),
    writeFile(path.join(defaultProfile, "Local Storage", "state"), "synthetic-local-storage"),
    writeFile(path.join(defaultProfile, "Preferences"), "{}"),
    writeFile(path.join(defaultProfile, "History"), "must-not-be-imported")
  ]);
  return { root, localAppData, appDataDirectory, defaultProfile };
}

test("detects standard Chrome profiles and identifies the existing Default profile", async (t) => {
  const fixture = await createChromeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const profiles = await detectBrowserProfiles({ localAppData: fixture.localAppData });

  assert.deepEqual(profiles, [
    {
      id: "chrome:Default",
      browser: "chrome",
      browserName: "Google Chrome",
      directoryName: "Default",
      name: "Default profile",
      isDefault: true
    },
    {
      id: "chrome:Profile 1",
      browser: "chrome",
      browserName: "Google Chrome",
      directoryName: "Profile 1",
      name: "Work profile",
      isDefault: false
    }
  ]);
});

test("imports session data from an existing profile into an isolated assistant profile", async (t) => {
  const fixture = await createChromeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const imported = await importBrowserProfile("chrome:Default", {
    localAppData: fixture.localAppData,
    appDataDirectory: fixture.appDataDirectory
  });

  assert.equal(imported.browser, "chrome");
  assert.equal(imported.profileDirectory, path.join(fixture.appDataDirectory, "imported-chrome-default"));
  assert.equal(
    await readFile(path.join(imported.profileDirectory, "Default", "Network", "Cookies"), "utf8"),
    "synthetic-cookie-store"
  );
  assert.equal(
    await readFile(path.join(imported.profileDirectory, "Default", "Local Storage", "state"), "utf8"),
    "synthetic-local-storage"
  );
  await assert.rejects(stat(path.join(imported.profileDirectory, "Default", "History")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(fixture.defaultProfile, "History"), "utf8"), "must-not-be-imported");

  const localState = JSON.parse(await readFile(path.join(imported.profileDirectory, "Local State"), "utf8"));
  assert.equal(localState.os_crypt.encrypted_key, "synthetic-key");
  assert.equal(localState.profile.last_used, "Default");
  assert.deepEqual(localState.profile.last_active_profiles, ["Default"]);
  assert.deepEqual(Object.keys(localState.profile.info_cache), ["Default"]);
});

test("profile import rejects selections that were not returned by detection", async (t) => {
  const fixture = await createChromeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    importBrowserProfile("chrome:..\\Default", {
      localAppData: fixture.localAppData,
      appDataDirectory: fixture.appDataDirectory
    }),
    /available browser profile/
  );
});

test("profile import refuses to copy a profile while its browser owns the user-data tree", async (t) => {
  const fixture = await createChromeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(path.join(fixture.localAppData, "Google", "Chrome", "User Data", "lockfile"), "locked");

  await assert.rejects(
    importBrowserProfile("chrome:Default", {
      localAppData: fixture.localAppData,
      appDataDirectory: fixture.appDataDirectory
    }),
    /Close Google Chrome completely/
  );
});

test("prepares a custom existing Chromium profile without moving or copying it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xsoar-custom-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const customProfile = path.join(root, "TSOC-Copilot");
  await mkdir(path.join(customProfile, "Default"), { recursive: true });
  await writeFile(path.join(customProfile, "Local State"), "{}");

  const prepared = await prepareBrowserProfileDirectory(customProfile);

  assert.equal(prepared, await realpath(customProfile));
  assert.equal(await readFile(path.join(customProfile, "Local State"), "utf8"), "{}");
});

test("custom profile paths reject non-browser directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xsoar-invalid-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "unrelated.txt"), "leave me alone");

  await assert.rejects(prepareBrowserProfileDirectory(root), /Chromium user-data directory/);
  assert.equal(await readFile(path.join(root, "unrelated.txt"), "utf8"), "leave me alone");
});

test("custom profiles must be closed before the assistant takes ownership", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xsoar-locked-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Default"));
  await writeFile(path.join(root, "lockfile"), "locked");

  await assert.rejects(prepareBrowserProfileDirectory(root), /Close the browser/);
});
