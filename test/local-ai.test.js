import test from "node:test";
import assert from "node:assert/strict";

import { buildEnrichmentEvidence, createOllamaClient, DEFAULT_OLLAMA_MODEL } from "../src/local-ai.js";

function response(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function streamedResponse(lines, delayMs = 0) {
  const encoder = new TextEncoder();
  let timer;
  return new Response(new ReadableStream({
      start(controller) {
        let index = 0;
        const write = () => {
          if (index >= lines.length) return controller.close();
          controller.enqueue(encoder.encode(`${JSON.stringify(lines[index++])}\n`));
          timer = setTimeout(write, delayMs);
        };
        if (delayMs) timer = setTimeout(write, delayMs); else write();
      },
      cancel() { clearTimeout(timer); }
    }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

test("local enrichment uses bounded allowlisted evidence and validates structured output", async () => {
  const requests = [];
  const client = createOllamaClient({ fetchImplementation: async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/tags")) return response({ models: [{ name: DEFAULT_OLLAMA_MODEL }] });
    if (url.endsWith("/api/show")) return response({});
    if (url.endsWith("/api/chat")) return response({ message: { content: JSON.stringify({
      investigationSummary: "Review observed event details.", relatedActivity: "Compare supplied historical incidents.",
      vendorGuidance: "Use applicable vendor documentation.", recommendations: ["Validate the affected system with its owner."]
    }) } });
    throw new Error(`Unexpected URL: ${url}`);
  } });
  const enrichment = await client.enrich({ model: DEFAULT_OLLAMA_MODEL, incident: { ticketId: "4200", unexpected: "do not send" }, historical: [] });
  assert.equal(enrichment.recommendations.length, 1);
  const body = JSON.parse(requests.find((request) => request.url.endsWith("/api/chat")).options.body);
  assert.equal(JSON.parse(body.messages[1].content).evidence.current.unexpected, undefined);
  assert.equal(body.options.num_ctx, 8192);
  assert.ok(requests.every((request) => request.options.redirect === "error"));
});

test("cloud aliases and remote metadata never reach chat or pull", async () => {
  const aliases = createOllamaClient({ fetchImplementation: async () => { throw new Error("No request expected."); } });
  await assert.rejects(() => aliases.enrich({ model: "qwen3.5:cloud", incident: {}, historical: [] }), /valid local Ollama model name/);
  const requests = [];
  const remote = createOllamaClient({ fetchImplementation: async (url) => {
    requests.push(url);
    return response({ models: [{ name: DEFAULT_OLLAMA_MODEL, remote_host: "cloud.example.test", remote_model: DEFAULT_OLLAMA_MODEL }] });
  } });
  assert.deepEqual((await remote.status()).models, []);
  await assert.rejects(() => remote.pull(DEFAULT_OLLAMA_MODEL), /not a local Ollama model/);
  assert.deepEqual(requests, ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/tags"]);
  const showRequests = [];
  const showRemote = createOllamaClient({ fetchImplementation: async (url) => {
    showRequests.push(url);
    if (url.endsWith("/api/tags")) return response({ models: [{ name: DEFAULT_OLLAMA_MODEL }] });
    if (url.endsWith("/api/show")) return response({ remote_host: "cloud.example.test", remote_model: DEFAULT_OLLAMA_MODEL });
    throw new Error("Chat must not receive incident evidence.");
  } });
  await assert.rejects(() => showRemote.enrich({ model: DEFAULT_OLLAMA_MODEL, incident: { ticketId: "4200" }, historical: [] }), /not a local Ollama model/);
  assert.deepEqual(showRequests, ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/show"]);
});

test("streaming pull survives ongoing progress and cancels a stalled stream", async () => {
  const progressing = createOllamaClient({ pullConnectTimeoutMs: 20, pullStallTimeoutMs: 25, fetchImplementation: async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("/api/tags")) return response({ models: [{ name: DEFAULT_OLLAMA_MODEL }] });
    if (url.endsWith("/api/pull")) return streamedResponse([{ status: "downloading", completed: 1, total: 3 }, { status: "downloading", completed: 2, total: 3 }, { status: "success", completed: 3, total: 3 }], 15);
    if (url.endsWith("/api/show")) return response({});
    throw new Error(`Unexpected URL: ${url}`);
  } });
  assert.deepEqual(await progressing.pull(DEFAULT_OLLAMA_MODEL), [DEFAULT_OLLAMA_MODEL]);
  const stalled = createOllamaClient({ pullConnectTimeoutMs: 20, pullStallTimeoutMs: 20, fetchImplementation: async (url) => {
    if (url.endsWith("/api/tags")) return response({ models: [] });
    if (url.endsWith("/api/pull")) return new Response(new ReadableStream({ start() {} }));
    throw new Error(`Unexpected URL: ${url}`);
  } });
  await assert.rejects(() => stalled.pull(DEFAULT_OLLAMA_MODEL), /stalled for 1 seconds/);
});

test("untagged model aliases resolve to the installed latest tag after pull and before enrichment", async () => {
  let tagRequests = 0;
  const requests = [];
  const installedName = "qwen3.5:latest";
  const client = createOllamaClient({ fetchImplementation: async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/api/tags")) {
      tagRequests += 1;
      return response({ models: tagRequests === 1 ? [] : [{ name: installedName }] });
    }
    if (url.endsWith("/api/pull")) return streamedResponse([{ status: "success" }]);
    if (url.endsWith("/api/show")) return response({});
    if (url.endsWith("/api/chat")) return response({ message: { content: JSON.stringify({
      investigationSummary: "Summary", relatedActivity: "Activity", vendorGuidance: "Guidance", recommendations: []
    }) } });
    throw new Error(`Unexpected URL: ${url}`);
  } });

  assert.deepEqual(await client.pull("qwen3.5"), [installedName]);
  await client.enrich({ model: "qwen3.5", incident: {}, historical: [] });
  const showBodies = requests.filter(({ url }) => url.endsWith("/api/show")).map(({ options }) => JSON.parse(options.body));
  const chatBody = JSON.parse(requests.find(({ url }) => url.endsWith("/api/chat")).options.body);
  assert.deepEqual(showBodies, [{ name: installedName }, { name: installedName }]);
  assert.equal(chatBody.model, installedName);
});

test("download stalls despite meaningless chunks and rejects an oversized partial progress line", async () => {
  let whitespaceTimer;
  const dripFeed = createOllamaClient({ pullConnectTimeoutMs: 20, pullStallTimeoutMs: 20, fetchImplementation: async (url) => {
    if (url.endsWith("/api/tags")) return response({ models: [] });
    if (url.endsWith("/api/pull")) return new Response(new ReadableStream({
      start(controller) { whitespaceTimer = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 5); },
      cancel() { clearInterval(whitespaceTimer); }
    }));
    throw new Error(`Unexpected URL: ${url}`);
  } });
  const startedAt = Date.now();
  await assert.rejects(() => dripFeed.pull(DEFAULT_OLLAMA_MODEL), /stalled for 1 seconds/);
  assert.ok(Date.now() - startedAt < 200, "meaningless chunks must not reset the progress watchdog");

  const oversized = createOllamaClient({ fetchImplementation: async (url) => {
    if (url.endsWith("/api/tags")) return response({ models: [] });
    if (url.endsWith("/api/pull")) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(70 * 1024))); controller.close(); }
    }));
    throw new Error(`Unexpected URL: ${url}`);
  } });
  await assert.rejects(() => oversized.pull(DEFAULT_OLLAMA_MODEL), /invalid model download progress/);
});

test("Ollama JSON endpoints reject oversized bodies before schema parsing", async () => {
  const declaredOversize = { headers: { "Content-Length": String(10 * 1024 * 1024) } };
  const tags = createOllamaClient({ fetchImplementation: async () => response({}, declaredOversize) });
  await assert.rejects(() => tags.listModels(), /model check response was too large/);

  const show = createOllamaClient({ fetchImplementation: async (url) => url.endsWith("/api/tags")
    ? response({ models: [{ name: DEFAULT_OLLAMA_MODEL }] })
    : response({}, declaredOversize) });
  await assert.rejects(() => show.enrich({ model: DEFAULT_OLLAMA_MODEL, incident: {}, historical: [] }), /model verification response was too large/);

  const chat = createOllamaClient({ fetchImplementation: async (url) => {
    if (url.endsWith("/api/tags")) return response({ models: [{ name: DEFAULT_OLLAMA_MODEL }] });
    if (url.endsWith("/api/show")) return response({});
    return new Response(JSON.stringify({ padding: "x".repeat(70 * 1024) }), { headers: { "Content-Type": "application/json" } });
  } });
  await assert.rejects(() => chat.enrich({ model: DEFAULT_OLLAMA_MODEL, incident: {}, historical: [] }), /draft request response was too large/);
});

test("redirect responses cannot forward incident evidence away from loopback", async () => {
  for (const status of [307, 308]) {
    let redirectedBody;
    const client = createOllamaClient({ fetchImplementation: async (url, options = {}) => {
      if (url.endsWith("/api/tags")) return response({ models: [{ name: DEFAULT_OLLAMA_MODEL }] });
      if (url.endsWith("/api/show")) return response({});
      if (url.endsWith("/api/chat")) {
        if (options.redirect !== "error") redirectedBody = options.body;
        return new Response(null, { status, headers: { Location: "https://attacker.example/collect" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    } });
    await assert.rejects(() => client.enrich({ model: DEFAULT_OLLAMA_MODEL, incident: { ticketId: "sensitive" }, historical: [] }), new RegExp(`draft request failed \\(${status}\\)`));
    assert.equal(redirectedBody, undefined);
  }
});

test("evidence is bounded", () => {
  assert.equal(buildEnrichmentEvidence({ descriptionLong: "a".repeat(1000) }, []).current.descriptionLong.length, 300);
});
