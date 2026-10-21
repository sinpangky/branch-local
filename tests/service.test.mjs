import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalService } from "../server/service.mjs";

const codec = {
  encrypt: (value) => `sealed:${Buffer.from(value).toString("base64")}`,
  decrypt: (value) => {
    if (!value.startsWith("sealed:")) throw new Error("invalid sealed value");
    return Buffer.from(value.slice(7), "base64").toString();
  },
};

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "branch-service-"));
  const services = [];
  const start = async (extra = {}) => {
    const service = await createLocalService({ dataDir, ...options, ...extra });
    services.push(service);
    return service;
  };
  const service = await start();
  t.after(async () => {
    await Promise.all(services.map((service) => service.close()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { service, dataDir, start };
}

function request(service, pathname, body, method = body === undefined ? "GET" : "PUT", extra = {}) {
  return service.handle(new Request(`branch-local://app${pathname}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    ...extra,
  }));
}

test("port-free custom-protocol requests share revision, backup and recovery behavior", async (t) => {
  const { service, dataDir, start } = await fixture(t);
  assert.deepEqual(await (await request(service, "/api/health")).json(), { ok: true });
  const original = await (await request(service, "/api/workspace")).json();
  const next = structuredClone(original);
  next.boards[0].title = "Desktop branch";
  const responses = await Promise.all([
    request(service, "/api/workspace", next),
    request(service, "/api/workspace", next),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const saved = await responses.find((response) => response.ok).json();
  assert.equal(saved.revision, original.revision + 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "workspace.json.backup"), "utf8")), original);
  await service.close();
  await writeFile(path.join(dataDir, "workspace.json"), "{damaged");
  const restored = await start();
  assert.deepEqual(await (await request(restored, "/api/workspace")).json(), original);
  assert.equal((await request(restored, "/api/workspace", original)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "workspace.json.backup"), "utf8")), original);
});

test("remembered secrets use the injected codec, survive restart and are never returned", async (t) => {
  const upstreamCalls = [];
  const { service, dataDir, start } = await fixture(t, {
    secretCodec: codec,
    fetchImpl: async (_url, options) => {
      upstreamCalls.push(options);
      return Response.json({ data: [{ id: "local-test" }] });
    },
  });
  const secret = "desktop-test-secret";
  const response = await request(service, "/api/settings", { apiKey: secret, rememberKey: true });
  const visible = await response.json();
  assert.equal(visible.hasApiKey, true);
  assert.equal(visible.keyStorage, "encrypted");
  assert.equal(visible.dataDirectory, dataDir);
  assert.doesNotMatch(JSON.stringify(visible), /desktop-test-secret|sealed:/);
  const disk = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  assert.equal(Object.hasOwn(disk, "apiKey"), false);
  assert.equal(codec.decrypt(disk.encryptedApiKey), secret);
  const restarted = await start();
  assert.equal((await (await request(restarted, "/api/settings")).json()).hasApiKey, true);
  assert.equal((await request(restarted, "/api/models", undefined, "POST")).status, 200);
  assert.equal(upstreamCalls[0].headers.Authorization, `Bearer ${secret}`);
  await request(restarted, "/api/settings", { rememberKey: false });
  const forgotten = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  assert.equal(Object.hasOwn(forgotten, "apiKey"), false);
  assert.equal(Object.hasOwn(forgotten, "encryptedApiKey"), false);
  assert.equal((await (await request(restarted, "/api/settings")).json()).hasApiKey, true);
  const memoryOnlyRestart = await start();
  assert.equal((await (await request(memoryOnlyRestart, "/api/settings")).json()).hasApiKey, false);
  await request(restarted, "/api/settings", { rememberKey: true });
  await request(restarted, "/api/settings", { clearApiKey: true });
  assert.equal((await (await request(restarted, "/api/settings")).json()).hasApiKey, false);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")), "encryptedApiKey"), false);
});

test("legacy plaintext is migrated safely and encryption failure preserves the original key", async (t) => {
  const { service, dataDir, start } = await fixture(t);
  await request(service, "/api/settings", { apiKey: "legacy-secret", rememberKey: true });
  const plaintextFile = await readFile(path.join(dataDir, "settings.json"), "utf8");
  await assert.rejects(() => start({ secretCodec: { ...codec, encrypt() { throw new Error("unavailable"); } } }), /设置文件读取失败/);
  assert.equal(await readFile(path.join(dataDir, "settings.json"), "utf8"), plaintextFile);
  const encrypted = await start({ secretCodec: codec });
  assert.equal((await (await request(encrypted, "/api/settings")).json()).hasApiKey, true);
  const disk = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  assert.equal(disk.apiKey, undefined);
  assert.equal(codec.decrypt(disk.encryptedApiKey), "legacy-secret");
  await assert.rejects(() => start(), /设置文件读取失败/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")), disk);
});

test("cancelling a returned desktop stream aborts and cancels its upstream request", async (t) => {
  let upstreamSignal;
  let cancelled = false;
  const { service } = await fixture(t, {
    fetchImpl: async (_url, { signal }) => {
      upstreamSignal = signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const response = await request(service, "/api/chat", { messages: [{ role: "user", content: "hi" }] }, "POST");
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  await reader.cancel();
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(cancelled, true);
});

test("desktop request signals and closing the service abort model work", async (t) => {
  const signals = [];
  const { service } = await fixture(t, {
    fetchImpl: async (_url, { signal }) => {
      signals.push(signal);
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const controller = new AbortController();
  const first = await request(service, "/api/chat", { messages: [{ role: "user", content: "hi" }] }, "POST", { signal: controller.signal });
  controller.abort();
  assert.equal(signals[0].aborted, true);
  await first.body.cancel();
  const second = await request(service, "/api/chat", { messages: [{ role: "user", content: "again" }] }, "POST");
  await service.close();
  assert.equal(signals[1].aborted, true);
  // close() must release its timeout even when the caller never consumes the response.
  assert.equal((await request(service, "/api/health")).status, 503);
});

test("desktop service validates routes, methods, JSON and streaming body limits", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, { fetchImpl: async () => { calls++; return Response.json({}); } });
  assert.equal((await request(service, "/index.html")).status, 404);
  assert.equal((await request(service, "/api/settings", undefined, "DELETE")).status, 404);
  assert.equal((await request(service, "/api/chat", { messages: [{ role: "tool", content: "hi" }] }, "POST")).status, 400);
  assert.equal(calls, 0);
  assert.equal((await service.handle(new Request("branch-local://app/api/settings", { method: "PUT", body: "{}" }))).status, 415);
  assert.equal((await service.handle(new Request("branch-local://app/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{broken" }))).status, 400);
  let cancelled = false;
  const oversized = new Request("branch-local://app/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, duplex: "half",
    body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }),
  });
  assert.equal((await service.handle(oversized)).status, 413);
  assert.equal(cancelled, true);
});

test("closing during an incoming save prevents a late write after shutdown", async (t) => {
  const { service, dataDir } = await fixture(t);
  let completeBody;
  const body = new ReadableStream({ start(controller) { completeBody = () => {
    controller.enqueue(new TextEncoder().encode('{"model":"late-model"}'));
    controller.close();
  }; } });
  const pending = service.handle(new Request("branch-local://app/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body, duplex: "half",
  }));
  await service.close();
  completeBody();
  assert.equal((await pending).status, 503);
  await assert.rejects(() => readFile(path.join(dataDir, "settings.json")), { code: "ENOENT" });
});

test("a desktop stream failure emits only a sanitized SSE error", async (t) => {
  let fail;
  const { service } = await fixture(t, {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        fail = () => controller.error(new Error("private-provider-detail secret-key"));
      },
    }), { headers: { "Content-Type": "text/event-stream" } }),
  });
  const response = await request(service, "/api/chat", { messages: [{ role: "user", content: "hi" }] }, "POST");
  const reader = response.body.getReader();
  await reader.read();
  fail();
  const error = new TextDecoder().decode((await reader.read()).value);
  assert.match(error, /event: error/);
  assert.doesNotMatch(error, /private-provider-detail|secret-key/);
  assert.equal((await reader.read()).done, true);
});

test("customization settings validate types and ranges, persist across restart and never store unknown fields", async (t) => {
  const { service, dataDir, start } = await fixture(t);
  const expected = {
    theme: "dark", fontSize: 20, lineHeight: 2.1, codeWrap: true, sendOnEnter: false,
    reduceMotion: true, showMinimap: false, panelWidth: 900, autoSummary: false, autoSummaryMaterials: true, autoLayout: false,
    summaryMaxLength: 300, maxOutputTokens: 4096, requestTimeoutSeconds: 300,
  };
  const saved = await request(service, "/api/settings", { ...expected, unexpected: "not persisted", dataDirectory: "not used" });
  assert.equal(saved.status, 200);
  const visible = await saved.json();
  for (const [key, value] of Object.entries(expected)) assert.equal(visible[key], value);
  assert.equal(visible.dataDirectory, dataDir);
  assert.equal(visible.unexpected, undefined);
  const restarted = await start();
  const restored = await (await request(restarted, "/api/settings")).json();
  for (const [key, value] of Object.entries(expected)) assert.equal(restored[key], value);
  const originalFile = await readFile(path.join(dataDir, "settings.json"), "utf8");
  for (const invalid of [
    { theme: "unknown" }, { fontSize: 11 }, { fontSize: 16.5 }, { fontSize: "16" },
    { lineHeight: 2.5 }, { lineHeight: null }, { panelWidth: 359 }, { panelWidth: 1601 },
    { summaryMaxLength: 79 }, { summaryMaxLength: 401 }, { maxOutputTokens: -1 }, { maxOutputTokens: 32769 },
    { maxOutputTokens: 8.5 }, { requestTimeoutSeconds: 29 }, { requestTimeoutSeconds: 601 },
    { codeWrap: "true" }, { autoSummary: 1 }, { autoSummaryMaterials: 1 }, { autoSummaryMaterials: "true" }, { autoLayout: 1 }, { sendOnEnter: null }, { reduceMotion: 0 }, { showMinimap: "false" },
  ]) assert.equal((await request(service, "/api/settings", invalid)).status, 400, JSON.stringify(invalid));
  assert.equal(await readFile(path.join(dataDir, "settings.json"), "utf8"), originalFile);
});

test("max_tokens is omitted by default and forwarded only for a configured positive limit", async (t) => {
  const calls = [];
  const { service } = await fixture(t, {
    fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: "ok" } }] }); },
  });
  const body = { messages: [{ role: "user", content: "token check" }] };
  await request(service, "/api/chat", body, "POST");
  assert.equal(Object.hasOwn(calls[0], "max_tokens"), false);
  await request(service, "/api/settings", { maxOutputTokens: 2048 });
  await request(service, "/api/chat", body, "POST");
  assert.equal(calls[1].max_tokens, 2048);
  await request(service, "/api/settings", { maxOutputTokens: 0 });
  await request(service, "/api/chat", body, "POST");
  assert.equal(Object.hasOwn(calls[2], "max_tokens"), false);
});

test("requestTimeoutSeconds controls and cancels the entire response stream", async (t) => {
  let upstreamSignal;
  let cancelled = false;
  const { service } = await fixture(t, {
    fetchImpl: async (_url, { signal }) => {
      upstreamSignal = signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  await request(service, "/api/settings", { requestTimeoutSeconds: 30 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = await request(service, "/api/chat", { messages: [{ role: "user", content: "hi" }] }, "POST");
  const reader = response.body.getReader();
  await reader.read();
  t.mock.timers.tick(29999);
  assert.equal(upstreamSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(cancelled, true);
  await reader.cancel();
});
