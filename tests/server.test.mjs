import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "../server/index.mjs";
import { DEFAULT_SHORTCUTS } from "../shared/shortcuts.mjs";

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dendraft-server-"));
  const dataDir = path.join(root, "data");
  const distDir = path.join(root, "dist");
  await mkdir(distDir);
  await writeFile(
    path.join(distDir, "index.html"),
    "<!doctype html><title>Dendraft</title>",
  );
  await writeFile(path.join(distDir, "app.js"), 'console.log("app")');
  const servers = [];
  const start = async (extra = {}) => {
    const server = await createAppServer({
      dataDir,
      distDir,
      ...options,
      ...extra,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const initial = await start();
  t.after(async () => {
    await Promise.all(servers.map(close));
    await rm(root, { recursive: true, force: true });
  });
  return { ...initial, dataDir, distDir, start };
}

function request(base, pathname, body, method = "POST", headers = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rawRequest(
  base,
  pathname,
  { method = "GET", headers = {}, chunks = [] } = {},
) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: pathname,
        method,
        headers,
      },
      (res) => {
        const data = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(data).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test("serves the local UI and applies Host, Origin and path protections", async (t) => {
  const { base } = await fixture(t, {
    allowedOrigins: ["http://127.0.0.1:5173"],
  });
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
    ok: true,
  });
  const page = await fetch(`${base}/board/a`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Dendraft/);
  assert.match(
    (await fetch(`${base}/app.js`)).headers.get("content-type"),
    /javascript/,
  );
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal(
    (await rawRequest(base, "/%2e%2e/server/index.mjs")).status,
    403,
  );
  assert.equal((await rawRequest(base, "/..%5cserver/index.mjs")).status, 403);
  assert.equal(
    (
      await rawRequest(base, "/api/health", {
        headers: { Host: "evil.example" },
      })
    ).status,
    403,
  );
  const hostile = await fetch(`${base}/api/workspace`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers.get("access-control-allow-origin"), null);
  assert.equal(
    (await fetch(`${base}/api/health`, { headers: { Origin: base } })).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/health`, {
        headers: { Origin: "http://127.0.0.1:5173" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/health`, {
        headers: { Origin: "http://127.0.0.1:5174" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(base, "/api/settings", { model: "test" }, "PUT", {
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
    403,
  );
});

test("workspace writes are validated, atomic, backed up and serialized by revision", async (t) => {
  const { base, dataDir, start } = await fixture(t);
  const workspace = await (await fetch(`${base}/api/workspace`)).json();
  const modified = structuredClone(workspace);
  modified.boards[0].title = "Saved branch workspace";
  const results = await Promise.all([
    request(base, "/api/workspace", modified, "PUT"),
    request(base, "/api/workspace", modified, "PUT"),
  ]);
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
  const saved = await results.find((res) => res.status === 200).json();
  assert.equal(saved.revision, workspace.revision + 1);
  assert.equal(saved.boards[0].title, modified.boards[0].title);
  assert.equal(
    JSON.parse(
      await readFile(path.join(dataDir, "workspace.json.backup"), "utf8"),
    ).revision,
    workspace.revision,
  );
  const invalid = { ...saved, boards: [] };
  assert.equal(
    (await request(base, "/api/workspace", invalid, "PUT")).status,
    400,
  );
  const restarted = await start();
  assert.deepEqual(
    await (await fetch(`${restarted.base}/api/workspace`)).json(),
    saved,
  );
});

test("a damaged primary workspace recovers the last backup without replacing it with damage", async (t) => {
  const { base, dataDir, start, server } = await fixture(t);
  const original = await (await fetch(`${base}/api/workspace`)).json();
  assert.equal(
    (await request(base, "/api/workspace", original, "PUT")).status,
    200,
  );
  await close(server);
  await writeFile(path.join(dataDir, "workspace.json"), "{broken");
  const restored = await start();
  const recovered = await (
    await fetch(`${restored.base}/api/workspace`)
  ).json();
  assert.deepEqual(recovered, original);
  assert.equal(
    (await request(restored.base, "/api/workspace", recovered, "PUT")).status,
    200,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(dataDir, "workspace.json.backup"), "utf8"),
    ),
    original,
  );
});

test("a valid workspace over 4 MiB can be saved after combining imported content", async (t) => {
  const { base, dataDir } = await fixture(t);
  const workspace = await (await fetch(`${base}/api/workspace`)).json();
  const root = workspace.boards[0].nodes.find((node) => node.parentId === null);
  for (let index = 0; index < 32; index += 1) {
    root.messages.push({
      id: `large-message-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: "界".repeat(50000),
      createdAt: new Date().toISOString(),
    });
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(workspace), "utf8") > 4 * 1024 * 1024,
  );
  const response = await request(base, "/api/workspace", workspace, "PUT");
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, workspace.revision + 1);
  assert.equal(
    saved.boards[0].nodes.find((node) => node.id === root.id).messages.at(-1)
      .content,
    "界".repeat(50000),
  );
  assert.equal(
    JSON.parse(await readFile(path.join(dataDir, "workspace.json"), "utf8"))
      .revision,
    saved.revision,
  );
});

test("keys default to memory, opt in to disk, never appear in responses, and can be cleared", async (t) => {
  const { base, dataDir, start } = await fixture(t);
  const defaults = await (await fetch(`${base}/api/settings`)).json();
  assert.deepEqual(defaults, {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    systemPrompt: "",
    temperature: 0.7,
    rememberKey: false,
    theme: "system",
    fontSize: 16,
    lineHeight: 1.65,
    codeWrap: false,
    sendOnEnter: true,
    reduceMotion: false,
    showMinimap: true,
    panelWidth: 560,
    autoSummary: true,
    autoSummaryMaterials: false,
    autoLayout: true,
    summaryMaxLength: 160,
    maxOutputTokens: 0,
    requestTimeoutSeconds: 120,
    agentEnabled: false, agentEngine:'compatible',agentWorkspace:'',agentAllowCommands:false,agentAllowNetwork:false,agentSearchEndpoint:'',agentMaxSteps:12,agentAvailable:false,
    shortcuts: DEFAULT_SHORTCUTS,
    hasApiKey: false,
    keyStorage: "plaintext",
    dataDirectory: dataDir,
  });
  const secret = "fake-unit-test-key";
  const update = await request(
    base,
    "/api/settings",
    { apiKey: secret, model: "local-model" },
    "PUT",
  );
  const visible = await update.json();
  assert.equal(visible.hasApiKey, true);
  assert.equal(JSON.stringify(visible).includes(secret), false);
  assert.equal(
    (await readFile(path.join(dataDir, "settings.json"), "utf8")).includes(
      secret,
    ),
    false,
  );
  const memoryRestart = await start();
  assert.equal(
    (await (await fetch(`${memoryRestart.base}/api/settings`)).json())
      .hasApiKey,
    false,
  );
  await request(base, "/api/settings", { rememberKey: true }, "PUT");
  assert.equal(
    JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"))
      .apiKey,
    secret,
  );
  const rememberedRestart = await start();
  assert.equal(
    (await (await fetch(`${rememberedRestart.base}/api/settings`)).json())
      .hasApiKey,
    true,
  );
  await request(
    base,
    "/api/settings",
    { rememberKey: false, apiKey: "" },
    "PUT",
  );
  assert.equal(
    (await (await fetch(`${base}/api/settings`)).json()).hasApiKey,
    true,
  );
  assert.equal(
    (await readFile(path.join(dataDir, "settings.json"), "utf8")).includes(
      secret,
    ),
    false,
  );
  await request(base, "/api/settings", { clearApiKey: true }, "PUT");
  assert.equal(
    (await (await fetch(`${base}/api/settings`)).json()).hasApiKey,
    false,
  );
});

test("models and chat use configured OpenAI compatible API and preserve SSE bytes", async (t) => {
  const calls = [];
  const sse =
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  const { base } = await fixture(t, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/models"))
        return Response.json({
          data: [{ id: "one" }, { id: "two" }, { id: "one" }, {}],
        });
      return new Response(sse, {
        headers: {
          "Content-Type": "text/event-stream",
          "X-Private": "must-not-leak",
        },
      });
    },
  });
  await request(
    base,
    "/api/settings",
    {
      baseUrl: "https://example.invalid/v1/",
      model: "one",
      apiKey: "fake-unit-test-key",
      systemPrompt: "Be precise.",
      temperature: 0.3,
    },
    "PUT",
  );
  const models = await request(base, "/api/models", {});
  assert.deepEqual(await models.json(), { models: ["one", "two"] });
  assert.equal(calls[0].url, "https://example.invalid/v1/models");
  assert.equal(calls[0].options.method, "GET");
  const chat = await request(base, "/api/chat", {
    messages: [
      { role: "system", content: "Branch quote" },
      { role: "user", content: "Hello" },
    ],
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get("x-private"), null);
  assert.equal(await chat.text(), sse);
  const sent = JSON.parse(calls[1].options.body);
  assert.deepEqual(sent, {
    model: "one",
    temperature: 0.3,
    stream: true,
    messages: [
      { role: "system", content: "Be precise." },
      { role: "system", content: "Branch quote" },
      { role: "user", content: "Hello" },
    ],
  });
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer fake-unit-test-key",
  );
});

test("API rejects invalid bodies and upstream failures without disclosing credentials or upstream text", async (t) => {
  let calls = 0;
  const { base } = await fixture(t, {
    fetchImpl: async () => {
      calls += 1;
      return new Response("private upstream error fake-unit-test-key", {
        status: 401,
      });
    },
  });
  assert.equal(
    (
      await request(base, "/api/chat", {
        messages: [{ role: "tool", content: "invalid" }],
      })
    ).status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await request(base, "/api/settings", { baseUrl: "file:///secret" }, "PUT"))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        base,
        "/api/settings",
        { apiKey: "key\r\ninjected: true" },
        "PUT",
      )
    ).status,
    400,
  );
  const upstreamError = await request(base, "/api/models", {});
  assert.equal(upstreamError.status, 502);
  const text = await upstreamError.text();
  assert.doesNotMatch(text, /fake-unit-test-key|private upstream/);
  assert.match(text, /401/);
  assert.equal(
    (
      await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{broken",
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/settings`, { method: "PUT", body: "{}" })).status,
    415,
  );
  assert.equal(
    (
      await request(
        base,
        "/api/settings",
        { systemPrompt: "x".repeat(4 * 1024 * 1024) },
        "PUT",
      )
    ).status,
    413,
  );
  const chunked = await rawRequest(base, "/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    chunks: ['{"systemPrompt":"', "x".repeat(4 * 1024 * 1024), '"}'],
  });
  assert.equal(chunked.status, 413);
});

test("chat accepts compatible nonstreaming JSON and excludes unrelated upstream fields and errors", async (t) => {
  let reply = {
    choices: [
      { message: { role: "assistant", content: "A complete answer." } },
    ],
    upstreamSecret: "private-value",
  };
  const { base } = await fixture(t, {
    fetchImpl: async () =>
      Response.json(reply, { headers: { "X-Private": "private-value" } }),
  });
  const response = await request(base, "/api/chat", {
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("x-private"), null);
  assert.deepEqual(await response.json(), {
    choices: [
      { message: { role: "assistant", content: "A complete answer." } },
    ],
  });
  reply = { error: { message: "private-value fake-unit-test-key" } };
  const failure = await request(base, "/api/chat", {
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /private-value|fake-unit-test-key/);
});

test("closing the browser stream aborts the model request", async (t) => {
  let reportAbort;
  const aborted = new Promise((resolve) => {
    reportAbort = resolve;
  });
  const { base } = await fixture(t, {
    fetchImpl: async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[]}\n\n'),
            );
            signal.addEventListener(
              "abort",
              () => {
                reportAbort(true);
                controller.close();
              },
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  const response = await request(base, "/api/chat", {
    messages: [{ role: "user", content: "hi" }],
  });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  let timeout;
  try {
    assert.equal(
      await Promise.race([
        aborted,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), 2000);
        }),
      ]),
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
});
