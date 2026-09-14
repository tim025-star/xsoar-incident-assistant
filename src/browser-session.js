import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import net from "node:net";

import { chromium } from "playwright-core";

import { assertIncidentUrl, assertTrustedUrl } from "./domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "./page-adapter.js";
import { APP_DATA_DIRECTORY } from "./config.js";

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

async function chooseLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
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
    this.browser = null;
    this.mode = null;
  }

  status() {
    return { running: Boolean(this.context), mode: this.mode };
  }

  async start(config, { cdpEndpoint } = {}) {
    if (this.context) return this.context;
    if (config.session.mode === "managed") {
      const profileDirectory = await ensureIsolatedProfile(config.session.profileDirectory);
      this.context = await chromium.launchPersistentContext(profileDirectory, {
        executablePath: findBrowserExecutable(config.session.browser),
        headless: false,
        viewport: null,
        acceptDownloads: false
      });
      this.mode = "managed";
      const pages = this.context.pages();
      const page = pages[0] || await this.context.newPage();
      if (!page.url() || page.url() === "about:blank") {
        await page.goto(config.xsoar.allowedOrigin, { waitUntil: "domcontentloaded" });
      }
      this.context.once("close", () => {
        this.context = null;
        this.mode = null;
      });
      return this.context;
    }

    if (!cdpEndpoint) throw new Error("Launch the separate debug browser before connecting.");
    this.browser = await chromium.connectOverCDP(cdpEndpoint, { noDefaults: true });
    this.context = this.browser.contexts()[0];
    if (!this.context) {
      this.browser = null;
      throw new Error("The debug browser did not expose a default context.");
    }
    this.mode = "cdp";
    this.browser.once("disconnected", () => {
      this.browser = null;
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
    if (this.mode === "managed") await this.context?.close();
    else await this.browser?.close();
    this.context = null;
    this.browser = null;
    this.mode = null;
  }
}

export async function launchDebugBrowser(config) {
  const executable = findBrowserExecutable(config.session.browser);
  const port = await chooseLoopbackPort();
  const debugProfile = await ensureIsolatedProfile(`${config.session.profileDirectory}-debug`);
  const child = spawn(executable, [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${debugProfile}`,
    config.xsoar.allowedOrigin
  ], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { browser: config.session.browser, profileDirectory: debugProfile, endpoint: `http://127.0.0.1:${port}` };
}
