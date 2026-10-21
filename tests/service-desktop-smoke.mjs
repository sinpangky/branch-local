// Run with Electron to exercise real protocol requests, safeStorage and cancellation.
import { app, BrowserWindow, protocol, safeStorage } from "electron";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalService } from "../server/service.mjs";

protocol.registerSchemesAsPrivileged([{ scheme: "branch-local", privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
let service;
let window;
let dataDir;
const streams = [];
const finish = async (code) => {
  window?.destroy();
  await service?.close();
  if (dataDir) {
    const resolved = path.resolve(dataDir);
    const prefix = path.join(path.resolve(os.tmpdir()), "branch-protocol-service-");
    if (!resolved.startsWith(prefix)) throw new Error("Refusing to remove unexpected smoke directory");
    await rm(resolved, { recursive: true, force: true });
  }
  app.exit(code);
};
let stage = "app readiness";
const deadline = setTimeout(() => { console.error(`Desktop service integration timed out during ${stage}`); void finish(1); }, 30000);

app.whenReady().then(async () => {
try {
  stage = "safeStorage availability";
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  dataDir = await mkdtemp(path.join(os.tmpdir(), "branch-protocol-service-"));
  service = await createLocalService({ dataDir });
  stage = "legacy settings write";
  await service.handle(new Request("branch-local://app/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "safe-storage-integration-secret", rememberKey: true }),
  }));
  await service.close();
  const secretCodec = {
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  };
  service = await createLocalService({ dataDir, secretCodec, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer safe-storage-integration-secret");
    if (options.method === "GET") return Response.json({ data: [{ id: "desktop-model" }] });
    const state = { signal: options.signal, cancelled: false };
    streams.push(state);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')); },
      cancel() { state.cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const persisted = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  assert.equal(Object.hasOwn(persisted, "apiKey"), false);
  assert.equal(secretCodec.decrypt(persisted.encryptedApiKey), "safe-storage-integration-secret");
  protocol.handle("branch-local", (request) => {
    stage = `${request.method} ${new URL(request.url).pathname}`;
    if (new URL(request.url).pathname.startsWith("/api/")) return service.handle(request);
    return new Response("<!doctype html><title>service smoke</title>", { headers: { "Content-Type": "text/html" } });
  });
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  stage = "window load";
  await window.loadURL("branch-local://app/");
  const result = await window.webContents.executeJavaScript(`(async () => {
    const settings = await (await fetch('/api/settings')).json();
    const models = await (await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    for (const mode of ['abort', 'cancel']) {
      const controller = new AbortController();
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: mode }] }), signal: controller.signal });
      const reader = response.body.getReader();
      await reader.read();
      if (mode === 'abort') controller.abort();
      else await reader.cancel();
    }
    return { hasApiKey: settings.hasApiKey, keyStorage: settings.keyStorage, models: models.models };
  })()`);
  assert.deepEqual(result, { hasApiKey: true, keyStorage: "encrypted", models: ["desktop-model"] });
  stage = "upstream cancellation";
  for (let attempt = 0; attempt < 30 && streams.some((state) => !state.signal.aborted || !state.cancelled); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(streams.length, 2);
  assert.ok(streams.every((state) => state.signal.aborted && state.cancelled), "Renderer abort and reader.cancel must abort/cancel upstream streams");
  console.log("Desktop service integration passed: renderer protocol JSON + real safeStorage migration + renderer abort + reader cancellation.");
  clearTimeout(deadline);
  await finish(0);
} catch (error) {
  console.error(error);
  clearTimeout(deadline);
  await finish(1);
}
});
