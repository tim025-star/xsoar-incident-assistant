import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserSessionManager, launchDebugBrowser } from "./browser-session.js";
import { loadConfig, saveConfig } from "./config.js";
import { runIncidentDraft } from "./workflow.js";

const PUBLIC_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]]
]);
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

function json(response, status, value) {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Request body must contain valid JSON.");
  }
}

function tokenMatches(actual, expected) {
  const supplied = Buffer.from(String(actual || ""));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export function createAssistantServer({ token = randomBytes(32).toString("base64url") } = {}) {
  const sessions = new BrowserSessionManager();
  let activity = { phase: "idle", detail: "Configure the assistant, then open a browser session.", draft: "" };
  let runningWorkflow = false;
  let debugEndpoint = "";
  let localOrigin = "";

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, localOrigin || "http://127.0.0.1");
      if (requestUrl.pathname.startsWith("/api/")) {
        if (!tokenMatches(request.headers["x-assistant-token"], token)) return json(response, 403, { error: "Invalid local session token." });
        if (request.headers.host !== new URL(localOrigin).host) return json(response, 403, { error: "Invalid host." });
        if (request.method !== "GET" && request.headers.origin !== localOrigin) return json(response, 403, { error: "Invalid origin." });

        if (request.method === "GET" && requestUrl.pathname === "/api/config") return json(response, 200, await loadConfig());
        if (request.method === "GET" && requestUrl.pathname === "/api/status") {
          return json(response, 200, { ...activity, session: sessions.status() });
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/config") {
          if (sessions.status().running) return json(response, 409, { error: "Close the current browser session before changing settings." });
          return json(response, 200, await saveConfig(await readJson(request)));
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/browser/open") {
          const config = await loadConfig({ requireTenant: true });
          activity = { phase: "opening", detail: "Opening the configured browser session.", draft: activity.draft };
          await sessions.start(config, { cdpEndpoint: debugEndpoint });
          activity = { phase: "ready", detail: config.session.mode === "managed"
            ? "Managed browser ready. Sign in to XSOAR if prompted, then open an incident."
            : "Connected to the separate debug browser. Open an XSOAR incident.", draft: activity.draft };
          return json(response, 200, { ok: true });
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/browser/stop") {
          const previousMode = sessions.status().mode;
          await sessions.stop();
          activity = { phase: "idle", detail: previousMode === "cdp"
            ? "Debug browser closed. Its separate sign-in profile was retained."
            : "Managed browser closed. Its dedicated sign-in profile was retained.", draft: activity.draft };
          return json(response, 200, { ok: true });
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/debug/launch") {
          const config = await loadConfig({ requireTenant: true });
          if (config.session.mode !== "cdp") return json(response, 409, { error: "Select Debug browser mode and save settings first." });
          const launched = await launchDebugBrowser(config);
          debugEndpoint = launched.endpoint;
          activity = { phase: "idle", detail: "Debug browser launched with a separate profile. Sign in, then select Connect browser.", draft: activity.draft };
          return json(response, 200, launched);
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/run") {
          if (runningWorkflow) return json(response, 409, { error: "A draft is already being generated." });
          const config = await loadConfig({ requireTenant: true });
          runningWorkflow = true;
          try {
            await sessions.start(config, { cdpEndpoint: debugEndpoint });
            const result = await runIncidentDraft({
              adapter: sessions.adapter(config.xsoar),
              settings: config.xsoar,
              onProgress: async (phase, detail) => { activity = { phase, detail, draft: activity.draft }; }
            });
            activity = { phase: "complete", detail: result.warning || `Draft ready. Reviewed ${result.reviewed} historical incident(s).`, draft: result.draft };
            return json(response, 200, result);
          } finally {
            runningWorkflow = false;
          }
        }
        return json(response, 404, { error: "Not found." });
      }

      if (request.method !== "GET" || !STATIC_FILES.has(requestUrl.pathname)) {
        response.writeHead(404, SECURITY_HEADERS);
        return response.end("Not found");
      }
      const [file, contentType] = STATIC_FILES.get(requestUrl.pathname);
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": contentType });
      response.end(await readFile(path.join(PUBLIC_DIRECTORY, file)));
    } catch (error) {
      activity = { phase: "error", detail: error instanceof Error ? error.message : String(error), draft: activity.draft };
      json(response, 400, { error: activity.detail });
    }
  });

  return {
    server,
    token,
    sessions,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const address = server.address();
      localOrigin = `http://127.0.0.1:${address.port}`;
      return `${localOrigin}/#${token}`;
    }
  };
}

function openDefaultBrowser(url) {
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createAssistantServer();
  const url = await app.listen(Number(process.env.XSOAR_ASSISTANT_PORT || 0));
  console.log("XSOAR Incident Assistant is running on this computer.");
  if (process.env.XSOAR_ASSISTANT_NO_OPEN !== "1") openDefaultBrowser(url);
  const shutdown = async () => {
    await app.sessions.stop().catch(() => {});
    app.server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
