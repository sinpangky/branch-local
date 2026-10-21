import http from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { createLocalService, HttpError } from "./service.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

function json(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function assertRequestHost(req, server) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); }
  catch { throw new HttpError(403, "Host 不被允许。"); }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) ||
    host.username || host.password || host.pathname !== "/" || host.search || host.hash ||
    Number(host.port || 80) !== server.address()?.port
  ) throw new HttpError(403, "Host 不被允许。");
  return host.origin;
}

// Drain rejected HTTP bodies, so an oversized request can still receive its 413.
function requestBody(req) {
  let cleanup;
  return new ReadableStream({
    start(controller) {
      const onData = (chunk) => {
        controller.enqueue(chunk);
        if (controller.desiredSize <= 0) req.pause();
      };
      const onEnd = () => { cleanup(); controller.close(); };
      const onError = () => { cleanup(); controller.error(new Error("Request interrupted")); };
      cleanup = () => {
        req.off("data", onData); req.off("end", onEnd);
        req.off("error", onError); req.off("aborted", onError);
      };
      req.on("data", onData); req.once("end", onEnd);
      req.once("error", onError); req.once("aborted", onError);
    },
    pull() { req.resume(); },
    cancel() { cleanup(); req.resume(); },
  });
}

/** Creates an HTTP server; desktop builds use createLocalService directly. */
export async function createAppServer({
  dataDir = path.join(ROOT, "data"), fetchImpl = globalThis.fetch,
  distDir = path.join(ROOT, "dist"), allowedOrigins = [], secretCodec,
} = {}) {
  const permittedOrigins = new Set(allowedOrigins.map((entry) => {
    const url = new URL(entry);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.origin !== entry)
      throw new Error("开发 Origin 必须是含明确端口的 http://127.0.0.1 或 http://localhost 地址。");
    return url.origin;
  }));
  const service = await createLocalService({ dataDir, fetchImpl, secretCodec });
  const server = http.createServer(async (req, res) => {
    try {
      const origin = assertRequestHost(req, server);
      let pathname;
      try { pathname = decodeURIComponent(req.url.split("?")[0]); }
      catch { throw new HttpError(400, "请求路径无效。"); }
      if (!pathname.startsWith("/") || pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes(".."))
        throw new HttpError(403, "请求路径不被允许。");
      if (pathname.startsWith("/api/")) {
        if (req.headers.origin && req.headers.origin !== origin && !permittedOrigins.has(req.headers.origin))
          throw new HttpError(403, "不允许其他网站访问本地 API。");
        if (!["GET", "HEAD"].includes(req.method) && req.headers["sec-fetch-site"] === "cross-site")
          throw new HttpError(403, "不允许跨站写入本地数据。");
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once("aborted", abort); res.once("close", abort);
        let reader;
        try {
          const hasBody = !["GET", "HEAD"].includes(req.method) && (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) > 0);
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const request = new Request(new URL(req.url, origin), {
            method: req.method, headers, signal: controller.signal,
            ...(hasBody ? { body: requestBody(req), duplex: "half" } : {}),
          });
          const response = await service.handle(request);
          if (request.body && !request.bodyUsed) await request.body.cancel().catch(() => {});
          if (res.destroyed) { await response.body?.cancel(); return; }
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.headers.get("content-type")?.includes("text/event-stream")) res.flushHeaders();
          reader = response.body?.getReader();
          if (reader) {
            while (!res.destroyed) {
              const { value, done } = await reader.read();
              if (done || res.destroyed) break;
              if (!res.write(value)) await once(res, "drain", { signal: controller.signal });
            }
          }
          if (!res.destroyed) res.end();
        } finally {
          await reader?.cancel().catch(() => {});
          req.off("aborted", abort); res.off("close", abort);
        }
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) throw new HttpError(405, "请求方法不支持。");
      const staticRoot = await realpath(distDir).catch(() => {
        throw new HttpError(503, "前端尚未构建，请先运行 npm run build。");
      });
      const requested = path.resolve(staticRoot, `.${pathname}`);
      if (requested !== staticRoot && !requested.startsWith(`${staticRoot}${path.sep}`))
        throw new HttpError(403, "请求路径不被允许。");
      let target = requested;
      try {
        target = await realpath(requested);
        if (!(await stat(target)).isFile()) target = path.join(staticRoot, "index.html");
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        if (path.extname(pathname)) throw new HttpError(404, "文件不存在。");
        target = path.join(staticRoot, "index.html");
      }
      target = await realpath(target);
      if (!target.startsWith(`${staticRoot}${path.sep}`)) throw new HttpError(403, "请求路径不被允许。");
      const info = await stat(target);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream",
        "Content-Length": info.size, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") return res.end();
      createReadStream(target).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      json(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : "本地服务器读取或保存失败，请检查磁盘权限与可用空间。",
      });
    }
  });
  server.on("close", () => { void service.close(); });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须是 1–65535 的整数。");
  const server = await createAppServer({
    dataDir: process.env.DENDRAFT_DATA_DIR || undefined,
    allowedOrigins: process.env.DEV_ORIGIN ? [process.env.DEV_ORIGIN] : [],
  });
  server.on("error", (error) => {
    console.error(`本地服务启动失败：${error.code || "未知错误"}。`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Dendraft Local: http://127.0.0.1:${port}`));
}
