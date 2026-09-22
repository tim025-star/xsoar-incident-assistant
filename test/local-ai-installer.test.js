import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertAllowedGitHubDownloadUrl, createLocalAiInstaller, downloadVerifiedAsset, LOCAL_AI_INSTALL_MANIFEST } from "../src/local-ai-installer.js";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

test("GitHub asset downloads only follow HTTPS redirects to pinned GitHub hosts and resume safely", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xsoar-ai-download-"));
  const destination = path.join(directory, "asset.bin");
  const content = Buffer.from("verified model bytes");
  await writeFile(`${destination}.partial`, content.subarray(0, 8));
  const requests = [];
  const asset = {
    name: "asset.bin",
    url: "https://github.com/example/project/releases/download/model-v1/asset.bin",
    size: content.length,
    sha256: sha256(content)
  };
  try {
    await downloadVerifiedAsset(asset, destination, { fetchImplementation: async (url, options) => {
      requests.push({ url: url.href, options });
      if (url.hostname === "github.com") {
        return new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/example/signed" } });
      }
      return new Response(content.subarray(8), {
        status: 206,
        headers: { "Content-Length": String(content.length - 8), "Content-Range": `bytes 8-${content.length - 1}/${content.length}` }
      });
    } });
    assert.deepEqual(await readFile(destination), content);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.redirect, "manual");
    assert.equal(requests[0].options.headers.Range, "bytes=8-");
    assert.throws(() => assertAllowedGitHubDownloadUrl("http://github.com/example/releases/download/v/a"), /outside GitHub/);
    assert.throws(() => assertAllowedGitHubDownloadUrl("https://attacker.example/a"), /outside GitHub/);
    await assert.rejects(
      () => downloadVerifiedAsset({ ...asset, sha256: "0".repeat(64) }, path.join(directory, "bad.bin"), {
        fetchImplementation: async () => new Response(content, { status: 200, headers: { "Content-Length": String(content.length) } })
      }),
      /checksum.*did not match/
    );
    await assert.rejects(
      () => downloadVerifiedAsset(asset, path.join(directory, "stalled.bin"), {
        stallTimeoutMs: 10,
        fetchImplementation: async () => new Response(new ReadableStream({ start() {} }), { status: 200 })
      }),
      /stalled while receiving/
    );
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("large asset progress is throttled while still reporting completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xsoar-ai-progress-"));
  const destination = path.join(directory, "asset.bin");
  const content = Buffer.alloc(9 * 1024 * 1024, 7);
  const updates = [];
  const asset = {
    name: "asset.bin",
    url: "https://github.com/example/project/releases/download/model-v1/asset.bin",
    size: content.length,
    sha256: sha256(content)
  };
  try {
    await downloadVerifiedAsset(asset, destination, {
      onProgress: (value) => updates.push(value),
      fetchImplementation: async () => new Response(new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < content.length; offset += 16 * 1024) controller.enqueue(content.subarray(offset, offset + 16 * 1024));
          controller.close();
        }
      }), { status: 200, headers: { "Content-Length": String(content.length) } })
    });
    assert.ok(updates.length >= 2);
    assert.ok(updates.length <= 4, `expected bounded progress updates, got ${updates.length}`);
    assert.equal(updates.at(-1).completed, content.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("published runner and default model assets stay pinned by size and SHA-256", () => {
  assert.deepEqual(LOCAL_AI_INSTALL_MANIFEST.runner, {
    name: "OllamaSetup.exe",
    version: "0.34.0",
    url: "https://github.com/ollama/ollama/releases/download/v0.34.0/OllamaSetup.exe",
    size: 1574272976,
    sha256: "e2b98770fb87f3b4c593c22f2e8eda59bcac1cd7b141f1388c4181a8bf271a72"
  });
  assert.equal(LOCAL_AI_INSTALL_MANIFEST.model.name, "qwen3.5:9b");
  assert.equal(LOCAL_AI_INSTALL_MANIFEST.model.size, 6594462816);
  assert.equal(LOCAL_AI_INSTALL_MANIFEST.model.sha256, "dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c");
  assert.deepEqual(LOCAL_AI_INSTALL_MANIFEST.model.parts.map(({ size, sha256 }) => ({ size, sha256 })), [
    { size: 1648615704, sha256: "6b2fbb3af29463c9cbba78ae6de4d878948ab2af3b1fa599bbd9f18c1478e0cc" },
    { size: 1648615704, sha256: "e95d949c86b4d1efc7fc3bc85d4ef88e2e7a761d0d15e5f5cf9c8413e26f2b8c" },
    { size: 1648615704, sha256: "36efc4b182a53779209fc45716fae82754b26a4731fd2e897040b34610a68da6" },
    { size: 1648615704, sha256: "072b2add80dd750f3fb9074b6d68013e09b2845ee8aeab475048098ea18a0a82" }
  ]);
});

test("a missing runner is downloaded from GitHub, launched directly, and version-checked", async () => {
  const appDataDirectory = await mkdtemp(path.join(os.tmpdir(), "xsoar-ai-runner-"));
  const runner = Buffer.from("runner");
  const modelName = "already-present:1b";
  const manifest = {
    runner: { name: "OllamaSetup.exe", version: "0.34.0", url: "https://github.com/ollama/ollama/releases/download/v0.34.0/OllamaSetup.exe", size: runner.length, sha256: sha256(runner) },
    model: { name: modelName, fileName: "unused.gguf", size: 0, sha256: sha256(""), parts: [] }
  };
  let installed = false;
  let serviceAvailable = false;
  const commands = [];
  const installer = createLocalAiInstaller({
    appDataDirectory,
    manifest,
    localAi: {
      status: async () => ({ available: serviceAvailable, models: serviceAvailable ? [modelName] : [], detail: "test" }),
      pull: async () => [modelName]
    },
    locateOllama: async () => installed ? "C:\\Ollama\\ollama.exe" : undefined,
    runExecutable: async (executable, arguments_, options = {}) => {
      commands.push({ executable, arguments_, options });
      if (arguments_.length === 0) { installed = true; return { stdout: "", stderr: "" }; }
      return { stdout: "ollama version is 0.34.0", stderr: "" };
    },
    startServer: () => { serviceAvailable = true; },
    fetchImplementation: async () => new Response(runner, { status: 200, headers: { "Content-Length": String(runner.length) } })
  });
  try {
    assert.deepEqual(await installer.installDefaultModel(), [modelName]);
    assert.deepEqual(commands.map(({ arguments_ }) => arguments_), [[], ["--version"]]);
    assert.equal(commands[0].options.inherit, true);
  } finally { await rm(appDataDirectory, { recursive: true, force: true }); }
});

test("default model parts are imported from GitHub while custom choices retain the Ollama registry path", async () => {
  const appDataDirectory = await mkdtemp(path.join(os.tmpdir(), "xsoar-ai-install-"));
  const first = Buffer.from("first-part-");
  const second = Buffer.from("second-part");
  const combined = Buffer.concat([first, second]);
  const modelName = "test-model:1b";
  const part = (name, content) => ({
    name,
    url: `https://github.com/example/project/releases/download/model-v1/${name}`,
    size: content.length,
    sha256: sha256(content)
  });
  const manifest = {
    runner: { name: "OllamaSetup.exe", version: "0.34.0", url: "https://github.com/ollama/ollama/releases/download/v0.34.0/OllamaSetup.exe", size: 1, sha256: sha256("x") },
    model: { name: modelName, fileName: "model.gguf", size: combined.length, sha256: sha256(combined), parts: [part("part01", first), part("part02", second)] }
  };
  let installed = false;
  const commands = [];
  const pulls = [];
  const localAi = {
    status: async () => ({ available: true, models: installed ? [modelName] : [], detail: "ready" }),
    pull: async (model) => { pulls.push(model); assert.equal(installed, true); return [model]; }
  };
  const installer = createLocalAiInstaller({
    appDataDirectory,
    manifest,
    localAi,
    locateOllama: async () => "C:\\Ollama\\ollama.exe",
    runExecutable: async (executable, arguments_, options = {}) => {
      commands.push({ executable, arguments_, options });
      if (arguments_[0] === "--version") return { stdout: "ollama version is 0.34.0", stderr: "" };
      assert.deepEqual(arguments_.slice(0, 3), ["create", modelName, "-f"]);
      assert.equal(await readFile(path.join(options.cwd, "model.gguf"), "utf8"), combined.toString());
      assert.equal(await readFile(arguments_[3], "utf8"), "FROM ./model.gguf\n");
      installed = true;
      return { stdout: "", stderr: "" };
    },
    fetchImplementation: async (url) => {
      const content = url.pathname.endsWith("part01") ? first : second;
      return new Response(content, { status: 200, headers: { "Content-Length": String(content.length) } });
    }
  });
  try {
    assert.deepEqual(await installer.installDefaultModel(), [modelName]);
    assert.equal(commands.length, 2);
    assert.deepEqual(await installer.installModel("custom-model:latest"), ["custom-model:latest"]);
    assert.deepEqual(pulls, [modelName, "custom-model:latest"]);
    assert.equal(commands.length, 3, "a custom registry model still verifies the installed Ollama runner");
    await assert.rejects(() => readFile(path.join(appDataDirectory, "local-ai-install", "model.gguf")), /ENOENT/);
    assert.match(await readFile(installer.logPath, "utf8"), /Installed and verified test-model:1b/);
  } finally { await rm(appDataDirectory, { recursive: true, force: true }); }
});
