// Isolated browser acceptance fixture. Never contacts a real model provider.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "../server/index.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const dataDir = await mkdtemp(path.join(os.tmpdir(), "branch-local-browser-"));
const artifactsDir = path.join(projectRoot, "artifacts");
const requestsFile = path.join(artifactsDir, "browser-requests.json");
await mkdir(artifactsDir, { recursive: true });
const requests = [];
let pendingRecord = Promise.resolve();
function recordRequests() {
  const snapshot = JSON.stringify({ mock: true, requests }, null, 2);
  pendingRecord = pendingRecord.then(() =>
    writeFile(requestsFile, `${snapshot}\n`, "utf8"),
  );
  return pendingRecord;
}
await recordRequests();

const encoder = new TextEncoder();
const fetchImpl = async (url, options = {}) => {
  if (options.signal?.aborted)
    throw new DOMException("Browser request was aborted.", "AbortError");
  if (url.endsWith("/models"))
    return Response.json({ data: [{ id: "mock-model" }] });
  if (!url.endsWith("/chat/completions"))
    throw new Error("The browser fixture refuses external AI requests.");

  const payload = JSON.parse(options.body);
  requests.push({
    at: new Date().toISOString(),
    model: payload.model,
    messages: payload.messages,
  });
  await recordRequests();
  console.log(
    `[MOCK] Chat request ${requests.length}: ${payload.messages.length} messages recorded.`,
  );

  let timer;
  let finished = false;
  let abortListener;
  const cleanup = () => {
    clearInterval(timer);
    if (abortListener)
      options.signal?.removeEventListener("abort", abortListener);
  };
  const body = new ReadableStream({
    start(controller) {
      const fragments = [
        "这是浏览器验收的模拟回答。",
        "分支上下文彼此独立，可以选中这句话继续探索。",
      ];
      let index = 0;
      abortListener = () => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.error(
          new DOMException("Browser request was aborted.", "AbortError"),
        );
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });
      if (options.signal?.aborted) return abortListener();
      timer = setInterval(() => {
        if (finished) return;
        const event = { choices: [{ delta: { content: fragments[index++] } }] };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
        if (index === fragments.length) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          finished = true;
          cleanup();
          controller.close();
        }
      }, 150);
    },
    cancel() {
      finished = true;
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
};

const server = await createAppServer({
  dataDir,
  distDir: path.join(projectRoot, "dist"),
  fetchImpl,
});
server.on("error", (error) => {
  console.error(`[MOCK] Fixture failed: ${error.code || error.message}`);
  process.exitCode = 1;
});
server.listen(4318, "127.0.0.1", () => {
  console.log("[MOCK] Browser acceptance fixture: http://127.0.0.1:4318");
  console.log(
    "[MOCK] All AI replies are simulated; no external AI network requests.",
  );
  console.log(`[MOCK] Isolated workspace: ${dataDir}`);
  console.log(`[MOCK] Captured request messages: ${requestsFile}`);
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
