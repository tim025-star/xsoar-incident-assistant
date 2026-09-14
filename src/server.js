import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import { loadConfig } from "./config.js";
import { activationHotkeySpec } from "./hotkey.js";
import { startKeyboardTrigger } from "./keyboard-trigger.js";
import { createAssistantRouter } from "./rpc.js";

const STATIC_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

function tokenMatches(actual, expected) {
  const supplied = Buffer.from(String(actual || ""));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createAssistantServer({
  token = randomBytes(32).toString("base64url"),
  hotkeyToken = randomBytes(32).toString("base64url"),
  routerOptions,
  keyboardTriggerStarter = startKeyboardTrigger
} = {}) {
  const app = new Hono();
  let localOrigin = "";
  let keyboardTrigger;
  let activeHotkey;
  let hotkeyError = "";

  const applyActivationHotkey = async (activationHotkey) => {
    if (!localOrigin) throw new Error("The local server must be listening before the keyboard trigger starts.");
    const nextHotkey = activationHotkeySpec(activationHotkey);
    if (keyboardTrigger && activeHotkey === nextHotkey.id) return;

    const previousHotkey = activeHotkey;
    await keyboardTrigger?.stop();
    keyboardTrigger = undefined;
    activeHotkey = undefined;
    try {
      keyboardTrigger = await keyboardTriggerStarter({
        endpoint: `${localOrigin}/internal/keyboard-trigger`,
        token: hotkeyToken,
        activationHotkey: nextHotkey.id
      });
      activeHotkey = nextHotkey.id;
      hotkeyError = "";
    } catch (error) {
      if (previousHotkey) {
        try {
          keyboardTrigger = await keyboardTriggerStarter({
            endpoint: `${localOrigin}/internal/keyboard-trigger`,
            token: hotkeyToken,
            activationHotkey: previousHotkey
          });
          activeHotkey = previousHotkey;
        } catch (restoreError) {
          hotkeyError = `The previous activation shortcut could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
          throw new Error(hotkeyError);
        }
      }
      throw error;
    }
  };

  const assistant = createAssistantRouter({
    ...routerOptions,
    activationShortcutStatus: () => ({ active: Boolean(keyboardTrigger), error: hotkeyError }),
    onConfigSaved: async (config) => {
      await applyActivationHotkey(config.session.activationHotkey);
      await routerOptions?.onConfigSaved?.(config);
    }
  });
  const rpcHandler = new RPCHandler(assistant.router, {
    plugins: [new BodyLimitPlugin({ maxBodySize: 65536 })]
  });

  app.use("*", async (context, next) => {
    await next();
    context.res = withSecurityHeaders(context.res);
  });

  app.use("/rpc/*", async (context, next) => {
    if (!tokenMatches(context.req.header("X-Assistant-Token"), token)) {
      return context.json({ error: "Invalid local session token." }, 403);
    }
    if (!localOrigin || context.req.header("Host") !== new URL(localOrigin).host) {
      return context.json({ error: "Invalid host." }, 403);
    }
    if (context.req.method !== "GET" && context.req.header("Origin") !== localOrigin) {
      return context.json({ error: "Invalid origin." }, 403);
    }
    const result = await rpcHandler.handle(context.req.raw, { prefix: "/rpc", context: {} });
    if (result.matched) return result.response;
    return next();
  });

  app.post("/internal/keyboard-trigger", async (context) => {
    if (!tokenMatches(context.req.header("X-Assistant-Hotkey-Token"), hotkeyToken)) {
      return context.json({ error: "Invalid keyboard trigger token." }, 403);
    }
    if (!localOrigin || context.req.header("Host") !== new URL(localOrigin).host) {
      return context.json({ error: "Invalid host." }, 403);
    }
    try {
      await assistant.generate();
      return context.body(null, 204);
    } catch (error) {
      const status = error?.code === "CONFLICT" ? 409 : 500;
      return context.json({ error: "The keyboard trigger could not generate a draft." }, status);
    }
  });

  app.get("/", serveStatic({ root: STATIC_DIRECTORY, path: "index.html" }));
  app.get("/assets/*", serveStatic({ root: STATIC_DIRECTORY }));
  app.notFound((context) => context.text("Not found", 404));
  app.onError((error, context) => {
    console.error("Local server request failed:", error);
    return context.json({ error: "The local assistant could not process the request." }, 500);
  });

  const server = createAdaptorServer({ fetch: app.fetch });
  return {
    server,
    token,
    sessions: assistant.sessions,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The local server did not provide a TCP address.");
      localOrigin = `http://127.0.0.1:${address.port}`;
      return `${localOrigin}/#${token}`;
    },
    async startKeyboardTrigger() {
      if (!keyboardTrigger) {
        const config = await (routerOptions?.configStore?.load || loadConfig)();
        try {
          await applyActivationHotkey(config.session.activationHotkey);
        } catch (error) {
          hotkeyError = error instanceof Error ? error.message : String(error);
          return { active: false, error: hotkeyError };
        }
      }
      return { active: true, error: "" };
    },
    async stopKeyboardTrigger() {
      await keyboardTrigger?.stop();
      keyboardTrigger = undefined;
      activeHotkey = undefined;
    }
  };
}

function openDefaultBrowser(url) {
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createAssistantServer();
  const url = await app.listen(Number(process.env.XSOAR_ASSISTANT_PORT || 0));
  const hotkey = await app.startKeyboardTrigger();
  const config = await loadConfig();
  console.log("XSOAR Incident Assistant is running on this computer.");
  if (hotkey.active) console.log(`Press ${activationHotkeySpec(config.session.activationHotkey).label} while an XSOAR incident is open to generate a draft in this local page.`);
  else console.warn(`The activation shortcut is unavailable: ${hotkey.error} Select another shortcut in Settings.`);
  if (process.env.XSOAR_ASSISTANT_NO_OPEN !== "1") openDefaultBrowser(url);
  const shutdown = async () => {
    await app.stopKeyboardTrigger().catch(() => {});
    await app.sessions.stop().catch(() => {});
    app.server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
