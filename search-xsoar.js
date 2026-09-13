// @ts-check
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");
const {
  assertTrustedIncidentUrl,
  assessHistoricalResults,
  buildSearchQuery,
  buildTemplate,
  collectHistoricalDetails,
  createProgressReporter,
  extractIncidentAcrossTabs,
  findActiveIncidentPage,
  headlessBrowserChannelForProduct,
  searchSimilarIncidents,
  settleWithin,
  validateConfig
} = require("./lib/xsoar");

const projectDirectory = __dirname;
const configPath = path.join(projectDirectory, "config.json");

function writeProtocolRecord(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function expandEnvironmentPath(value) {
  return String(value || "").replace(/%([^%]+)%/g, (token, name) => process.env[name] ?? token);
}

async function detectHeadlessBrowserChannel(page) {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const version = await session.send("Browser.getVersion");
    return headlessBrowserChannelForProduct(version?.product);
  } catch {
    // Fall back to the broadly available Chrome channel when product detection is unavailable.
  } finally {
    if (session) await session.detach().catch(() => {});
  }
  return headlessBrowserChannelForProduct("");
}

function emptyOutput() {
  return {
    ok: false,
    ticketId: "",
    incidentName: "",
    ruleName: "",
    caseType: "",
    searchQuery: "",
    matches: 0,
    reviewedMatches: 0,
    collectionLimited: false,
    collectionIncomplete: false,
    tickets: [],
    customerName: "",
    customerShortName: "",
    classification: "",
    owner: "",
    severity: "",
    description: "",
    occurred: "",
    phase: "",
    incidentOutcome: "",
    closeNotes: "",
    descriptionLong: "",
    clientIp: "",
    clientHostname: "",
    clientUserName: "",
    destinationIp: "",
    deviceHostname: "",
    eventInfo: "",
    eventName: "",
    detectionUrl: "",
    errorMessage: "",
    serviceMessage: "",
    sourceHostname: "",
    sourceIp: "",
    sourceUsername: "",
    historical: [],
    warnings: [],
    warning: ""
  };
}

async function main() {
  const output = emptyOutput();
  let resultRecord;
  let browser;
  let headlessBrowser;
  let sourceIncidentPage;
  let incidentPage;
  let searchPage;
  let reportProgress = async (_stage, _detail) => {};

  try {
    const config = validateConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
    reportProgress = createProgressReporter(config.debugMode, writeProtocolRecord);
    await reportProgress("connecting_chrome", "Connecting to the configured Chrome debugging session.");
    browser = await chromium.connectOverCDP(config.cdpEndpoint);
    await reportProgress("finding_incident_tab", "Finding the active XSOAR incident tab.");
    sourceIncidentPage = await findActiveIncidentPage(
      browser,
      config.incidentUrlPattern,
      config.allowedXsoarOrigins
    );
    sourceIncidentPage.setDefaultTimeout(config.navigationTimeoutMs);
    await sourceIncidentPage.bringToFront();

    if (config.headless) {
      await reportProgress("copying_browser_session", "Copying the signed-in browser session into a temporary headless context.");
      const storageState = await sourceIncidentPage.context().storageState();
      const launchOptions = { headless: true };
      const channel = config.headlessBrowserChannel === "auto"
        ? await detectHeadlessBrowserChannel(sourceIncidentPage)
        : config.headlessBrowserChannel;
      if (config.headlessExecutablePath) {
        launchOptions.executablePath = expandEnvironmentPath(config.headlessExecutablePath);
      } else if (channel !== "chromium") {
        launchOptions.channel = channel;
      }
      headlessBrowser = await chromium.launch(launchOptions);
      const headlessContext = await headlessBrowser.newContext({ storageState });
      incidentPage = await headlessContext.newPage();
      incidentPage.setDefaultTimeout(config.navigationTimeoutMs);
      const sourceIncidentUrl = assertTrustedIncidentUrl(
        sourceIncidentPage.url(),
        config.incidentUrlPattern,
        config.allowedXsoarOrigins,
        "The selected incident"
      );
      await incidentPage.goto(sourceIncidentUrl, { waitUntil: "domcontentloaded" });
      assertTrustedIncidentUrl(
        incidentPage.url(),
        config.incidentUrlPattern,
        config.allowedXsoarOrigins,
        "Headless navigation"
      );
    } else {
      incidentPage = sourceIncidentPage;
      await incidentPage.bringToFront();
    }
    await reportProgress("waiting_for_incident", "Waiting for the incident fields to finish rendering.");

    await reportProgress("reading_incident", "Reading the Incident Info and Investigation fields.");
    const extracted = await extractIncidentAcrossTabs(
      incidentPage.context(),
      incidentPage,
      config,
      reportProgress
    );
    Object.assign(output, extracted.incident);
    if (!output.ruleName || !output.caseType) {
      const missing = [!output.ruleName && "Rule Name", !output.caseType && "Type"].filter(Boolean);
      output.warnings.push(`Search skipped because these fields are missing: ${missing.join(", ")}.`);
    } else {
      output.searchQuery = buildSearchQuery(output.ruleName, output.caseType);
      const incidentContext = incidentPage.context();
      const result = await searchSimilarIncidents(
        incidentContext,
        incidentPage,
        output,
        config,
        reportProgress
      );
      searchPage = result.searchPage;
      output.matches = result.matches;
      output.rawMatches = result.rawMatches;
      output.reviewedMatches = result.tickets.length;
      output.collectionLimited = result.collectionLimited;
      output.collectionIncomplete = result.collectionIncomplete;
      output.tickets = result.tickets.map((ticket) => ticket.ticketId);
      if (result.collectionIncomplete) {
        const requested = Math.min(result.matches, config.maxHistoricalIncidents);
        output.warnings.push(
          `XSOAR exposed ${result.tickets.length} of up to ${requested} historical ticket IDs; continuing with the available incidents.`
        );
      }
      if (config.collectHistoricalDetails) {
        output.historical = await collectHistoricalDetails(
          incidentContext,
          extracted.incidentInfoUrl,
          result.tickets,
          config,
          reportProgress
        );
        const historicalWarning = assessHistoricalResults(output.historical);
        if (historicalWarning) output.warnings.push(historicalWarning);
      }
    }

    output.warning = output.warnings.join(" ");
    await reportProgress("building_template", "Building the Notepad++ incident template.");
    const template = buildTemplate(output, config.template);
    output.ok = true;
    resultRecord = {
      type: "result",
      ok: true,
      template,
      warning: output.warning
    };
  } catch (error) {
    output.ok = false;
    output.error = error instanceof Error ? error.message : String(error);
    await reportProgress("failed", output.error);
    resultRecord = {
      type: "result",
      ok: false,
      error: output.error
    };
    process.exitCode = 1;
  } finally {
    const cleanupTimeoutMs = 3000;
    if (searchPage) {
      await reportProgress("closing_search_tab", "Closing the temporary Incidents search tab.");
      await settleWithin(() => searchPage.close(), cleanupTimeoutMs);
    }
    if (incidentPage) {
      await reportProgress("restoring_incident_tab", "Returning to the original incident tab.");
      if (sourceIncidentPage) {
        await settleWithin(() => sourceIncidentPage.bringToFront(), cleanupTimeoutMs);
      }
    }
    if (headlessBrowser) {
      await reportProgress("closing_headless_browser", "Closing the temporary headless Chromium session.");
      await settleWithin(() => headlessBrowser.close(), cleanupTimeoutMs);
    }
    // Closing a Browser connected over CDP may close the analyst's real Chrome
    // process. Close only Playwright's client transport and leave Chrome alive.
    const browserWithConnection = /** @type {typeof browser & {_connection?: {close: () => Promise<void>}}} */ (browser);
    if (browserWithConnection?._connection) {
      await reportProgress("disconnecting_browser", "Disconnecting the browser helper while leaving Chrome open.");
      await settleWithin(() => browserWithConnection._connection.close(), cleanupTimeoutMs);
    }
    if (output.ok) {
      await reportProgress("browser_complete", "Browser work finished; handing the template to AutoHotkey.");
    } else if (output.error) {
      await reportProgress("failed", output.error);
    }
  }

  writeProtocolRecord(resultRecord || {
    type: "result",
    ok: false,
    error: "The browser helper did not return a result."
  });
}

main().catch((error) => {
  process.exitCode = 1;
  writeProtocolRecord({
    type: "result",
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
});
