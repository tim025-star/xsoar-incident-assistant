import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { chromium } from "playwright-core";

import { assertIncidentUrl, assertTrustedUrl } from "./domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "./page-adapter.js";
import { APP_DATA_DIRECTORY } from "./config.js";
import { activationHotkeySpec } from "./hotkey.js";

function installShortcutListener({ bindingName, hotkey }) {
  const markerName = `${bindingName}_installed`;
  if (window.top !== window || window[markerName]) return;
  Object.defineProperty(window, markerName, { value: true });
  const modifiersFor = (event) => (event.altKey ? 1 : 0)
    | (event.ctrlKey ? 2 : 0)
    | (event.shiftKey ? 4 : 0)
    | (event.metaKey ? 8 : 0);
  window.addEventListener("keydown", (event) => {
    if (event.repeat || event.code !== hotkey.code || modifiersFor(event) !== hotkey.modifiers) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void window[bindingName]().catch(() => {});
  }, true);
}

export async function attachBrowserActivationShortcut(context, config, onActivationShortcut) {
  if (typeof onActivationShortcut !== "function") throw new Error("The browser activation shortcut requires a handler.");
  const hotkey = activationHotkeySpec(config.session.activationHotkey);
  const bindingName = `__xsoarAssistantActivate_${randomBytes(16).toString("hex")}`;
  await context.exposeBinding(bindingName, async ({ page, frame }) => {
    if (!page || frame !== page.mainFrame()) return;
    assertIncidentUrl(page.url(), config.xsoar, "Shortcut page");
    if (!await page.evaluate(() => document.hasFocus()).catch(() => false)) return;
    await onActivationShortcut();
  });
  const payload = { bindingName, hotkey };
  await context.addInitScript(installShortcutListener, payload);
  await Promise.all(context.pages()
    .filter((page) => !page.url().startsWith("devtools://"))
    .map((page) => page.evaluate(installShortcutListener, payload).catch(() => {})));
}

function browserExecutableCandidates(browser) {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean);
  const suffix = browser === "edge"
    ? ["Microsoft", "Edge", "Application", "msedge.exe"]
    : ["Google", "Chrome", "Application", "chrome.exe"];
  return roots.map((root) => path.join(root, ...suffix));
}

function findBrowserExecutable(browser) {
  const executable = browserExecutableCandidates(browser).find(existsSync);
  if (!executable) throw new Error(`${browser === "edge" ? "Microsoft Edge" : "Google Chrome"} was not found.`);
  return executable;
}

async function ensureIsolatedProfile(profileDirectory) {
  await mkdir(APP_DATA_DIRECTORY, { recursive: true });
  await mkdir(profileDirectory, { recursive: true });
  const [root, profile, stat] = await Promise.all([
    realpath(APP_DATA_DIRECTORY),
    realpath(profileDirectory),
    lstat(profileDirectory)
  ]);
  const relative = path.relative(root, profile);
  if (stat.isSymbolicLink() || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The browser profile must be a real directory inside the assistant application-data directory.");
  }
  return profile;
}

class PlaywrightBrowserAdapter {
  constructor(context, settings) {
    this.context = context;
    this.settings = settings;
  }

  async getActiveTab() {
    const candidates = this.context.pages().filter((page) => {
      try {
        assertIncidentUrl(page.url(), this.settings, "Browser tab");
        return true;
      } catch {
        return false;
      }
    });
    if (!candidates.length) throw new Error("Open an XSOAR incident in the automation browser before generating a draft.");
    const focused = [];
    for (const page of candidates) {
      if (await page.evaluate(() => document.hasFocus()).catch(() => false)) focused.push(page);
    }
    if (focused.length === 1) return { id: focused[0], url: focused[0].url() };
    if (candidates.length === 1) return { id: candidates[0], url: candidates[0].url() };
    throw new Error("More than one XSOAR incident is open. Bring the incident you want to process to the front and try again.");
  }

  async openTab(url) {
    const page = await this.context.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try {
          assertTrustedUrl(request.url(), this.settings, "Automated navigation");
        } catch {
          return route.abort("blockedbyclient");
        }
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.settings.pageReadyTimeoutMs });
    return { id: page, url: page.url() };
  }

  async waitUntilReady(page, timeoutMs) {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  }

  async getTabUrl(page) {
    return page.url();
  }

  async extractIncident(page, settings) {
    return page.evaluate(extractIncidentFromPage, settings);
  }

  async extractSearchResults(page, options) {
    return page.evaluate(extractSearchResultsFromPage, {
      ...options,
      expectedOrigin: this.settings.allowedOrigin,
      expectedPath: new URL(this.settings.incidentsPath, this.settings.allowedOrigin).pathname,
      queryParameter: this.settings.searchQueryParameter
    });
  }

  async closeTab(page) {
    if (!page.isClosed()) await page.close();
  }

  async focusTab(page) {
    if (!page.isClosed()) await page.bringToFront();
  }
}

export class BrowserSessionManager {
  constructor() {
    this.context = null;
    this.mode = null;
  }

  status() {
    return { running: Boolean(this.context), mode: this.mode };
  }

  async start(config, { onActivationShortcut } = {}) {
    if (this.context) return this.context;
    const profileDirectory = await ensureIsolatedProfile(config.session.profileDirectory);
    const diagnostics = config.session.mode === "diagnostics";
    this.context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: findBrowserExecutable(config.session.browser),
      headless: false,
      viewport: null,
      acceptDownloads: false,
      args: diagnostics ? ["--auto-open-devtools-for-tabs"] : []
    });
    if (onActivationShortcut) {
      await attachBrowserActivationShortcut(this.context, config, onActivationShortcut);
    }
    this.mode = config.session.mode;
    const pages = this.context.pages();
    const page = pages.find((candidate) => !candidate.url().startsWith("devtools://")) || await this.context.newPage();
    if (!page.url() || page.url() === "about:blank") {
      await page.goto(config.xsoar.allowedOrigin, { waitUntil: "domcontentloaded" });
    }
    this.context.once("close", () => {
      this.context = null;
      this.mode = null;
    });
    return this.context;
  }

  adapter(settings) {
    if (!this.context) throw new Error("Open the automation browser first.");
    return new PlaywrightBrowserAdapter(this.context, settings);
  }

  async stop() {
    await this.context?.close();
    this.context = null;
    this.mode = null;
  }
}
