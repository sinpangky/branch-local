import { mkdir, readFile, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createWorkspace, validateWorkspace } from "../shared/core.mjs";
import { generateBranchSummary, readSummaryCompletion, SummaryError } from "./summaries.mjs";
import { DEFAULT_SHORTCUTS, validateShortcuts } from "../shared/shortcuts.mjs";
import { normalizeUsage } from "../shared/provider.mjs";
import { getComparisonSources } from "../shared/comparison.mjs";
import { generateComparison } from "./comparison.mjs";
import { createAgentRuntime, AgentError } from './agent.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 4 * 1024 * 1024;
const MAX_WORKSPACE_BODY = 64 * 1024 * 1024;
const DEFAULT_SETTINGS = Object.freeze({
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
  agentEnabled: false,
  agentEngine: 'compatible',
  agentWorkspace: '',
  agentAllowCommands: false,
  agentAllowNetwork: false,
  agentSearchEndpoint: '',
  agentMaxSteps: 12,
  shortcuts: DEFAULT_SHORTCUTS,
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, payload) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readJson(request, bodyLimit = MAX_BODY) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
    throw new HttpError(415, "请求需要使用 application/json。");
  const tooLarge = () => new HttpError(413, `请求内容超过 ${bodyLimit / 1024 / 1024} MB。`);
  if (Number(request.headers.get("content-length")) > bodyLimit) {
    await request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > bodyLimit) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "请求读取失败或已取消。");
    } finally {
      reader.releaseLock();
    }
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求不是有效的 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "请求必须是 JSON 对象。");
  return value;
}

async function atomicJson(filename, value, { backup = true } = {}) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const backupTemporary = `${filename}.${randomUUID()}.backup.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    if (backup) {
      try {
        await copyFile(filename, backupTemporary);
        await rename(backupTemporary, `${filename}.backup`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await rename(temporary, filename);
  } finally {
    await Promise.allSettled([unlink(temporary), unlink(backupTemporary)]);
  }
}

function checkedSettings(input, current = DEFAULT_SETTINGS) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "设置必须是 JSON 对象。");
  const result = { ...current };
  if (Object.hasOwn(input, "baseUrl")) {
    if (typeof input.baseUrl !== "string" || input.baseUrl.length > 2048)
      throw new HttpError(400, "API 地址格式错误。");
    let url;
    try { url = new URL(input.baseUrl); }
    catch { throw new HttpError(400, "API 地址格式错误。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new HttpError(400, "API 地址需要 http(s)，且不能包含账号、查询参数或片段。");
    result.baseUrl = url.href.replace(/\/+$/, "");
  }
  for (const [key, maximum] of [["model", 256], ["systemPrompt", 100000]]) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== "string" || input[key].length > maximum || (key === "model" && !input[key].trim()))
        throw new HttpError(400, `${key} 格式错误或内容过长。`);
      result[key] = key === "model" ? input[key].trim() : input[key];
    }
  }
  if (Object.hasOwn(input, "temperature")) {
    if (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)
      throw new HttpError(400, "temperature 必须在 0–2 之间。");
    result.temperature = input.temperature;
  }
  for (const key of ["rememberKey", "clearApiKey", "codeWrap", "sendOnEnter", "reduceMotion", "showMinimap", "autoSummary", "autoSummaryMaterials", "autoLayout", 'agentEnabled', 'agentAllowCommands', 'agentAllowNetwork']) {
    if (Object.hasOwn(input, key) && typeof input[key] !== "boolean")
      throw new HttpError(400, `${key} 必须是布尔值。`);
  }
  for (const key of ["rememberKey", "codeWrap", "sendOnEnter", "reduceMotion", "showMinimap", "autoSummary", "autoSummaryMaterials", "autoLayout", 'agentEnabled', 'agentAllowCommands', 'agentAllowNetwork'])
    if (Object.hasOwn(input, key)) result[key] = input[key];
  if (Object.hasOwn(input, "theme")) {
    if (!["system", "light", "dark"].includes(input.theme))
      throw new HttpError(400, "theme 必须为 system、light 或 dark。");
    result.theme = input.theme;
  }
  for (const [key, minimum, maximum, integer] of [
    ["fontSize", 12, 24, true], ["lineHeight", 1.4, 2.4, false],
    ["panelWidth", 360, 1600, true], ["summaryMaxLength", 80, 400, true],
    ["maxOutputTokens", 0, 32768, true], ["requestTimeoutSeconds", 30, 600, true], ['agentMaxSteps', 1, 30, true],
  ]) {
    if (!Object.hasOwn(input, key)) continue;
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < minimum
        || input[key] > maximum || (integer && !Number.isSafeInteger(input[key])))
      throw new HttpError(400, `${key} 必须为 ${minimum}–${maximum} 之间的${integer ? "整数" : "数值"}。`);
    result[key] = input[key];
  }
  if (Object.hasOwn(input, "shortcuts")) {
    try { result.shortcuts = validateShortcuts(input.shortcuts, current.shortcuts ?? DEFAULT_SHORTCUTS); }
    catch (error) { throw new HttpError(400, error.message); }
  }
  if (Object.hasOwn(input, "apiKey")) {
    if (typeof input.apiKey !== "string" || input.apiKey.length > 16000 || /[\r\n]/.test(input.apiKey))
      throw new HttpError(400, "API Key 格式错误或过长。");
    if (input.apiKey.trim()) result.apiKey = input.apiKey.trim();
  }
  if(Object.hasOwn(input,'agentEngine')){
    if(input.agentEngine!=='compatible')throw new HttpError(400,'Agent 执行引擎不可用。');
    result.agentEngine=input.agentEngine;
  }
  if(Object.hasOwn(input,'agentWorkspace')){
    if(typeof input.agentWorkspace!=='string'||input.agentWorkspace.length>2048||input.agentWorkspace.includes('\0')||(input.agentWorkspace&&!path.isAbsolute(input.agentWorkspace)))throw new HttpError(400,'Agent 工作目录必须为本机绝对路径。');
    result.agentWorkspace=input.agentWorkspace?path.resolve(input.agentWorkspace):'';
  }
  if(Object.hasOwn(input,'agentSearchEndpoint')){
    if(typeof input.agentSearchEndpoint!=='string'||input.agentSearchEndpoint.length>2048)throw new HttpError(400,'搜索服务地址无效。');
    if(input.agentSearchEndpoint){
      let url;try{url=new URL(input.agentSearchEndpoint);}catch{throw new HttpError(400,'搜索服务需要 HTTPS 地址。');}
      if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new HttpError(400,'搜索服务需要不含账号、查询参数或片段的 HTTPS 地址。');
      result.agentSearchEndpoint=url.href.replace(/\/+$/,'');
    }else result.agentSearchEndpoint='';
  }
  if(result.agentEnabled&&!result.agentWorkspace)throw new HttpError(400,'开启 Agent 前需要选择工作目录。');
  if (input.clearApiKey) delete result.apiKey;
  return result;
}

function checkedMessages(input) {
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 20000)
    throw new HttpError(400, "messages 需要包含对话消息。");
  return input.messages.map((entry) => {
    if (!entry || !["system", "user", "assistant"].includes(entry.role) || typeof entry.content !== "string" || entry.content.length > 100100)
      throw new HttpError(400, "消息角色或内容无效。");
    return { role: entry.role, content: entry.content };
  });
}

/** Owns local data and model requests, without opening any network listener. */
export async function createLocalService({
  dataDir = path.join(ROOT, "data"),
  fetchImpl = globalThis.fetch,
  secretCodec,
  allowAgent = false,
  agentToolFactory,
  agentEngines,
} = {}) {
  if (secretCodec && (typeof secretCodec.encrypt !== "function" || typeof secretCodec.decrypt !== "function"))
    throw new Error("密钥存储需要同时提供 encrypt 和 decrypt。");
  dataDir = path.resolve(dataDir);
  await mkdir(dataDir, { recursive: true });
  const workspaceFile = path.join(dataDir, "workspace.json");
  const settingsFile = path.join(dataDir, "settings.json");
  let workspace;
  let recoveredBackup = false;
  try {
    workspace = validateWorkspace(JSON.parse(await readFile(workspaceFile, "utf8")));
  } catch (primaryError) {
    try {
      workspace = validateWorkspace(JSON.parse(await readFile(`${workspaceFile}.backup`, "utf8")));
      recoveredBackup = true;
      console.warn("工作区文件不可用，已恢复上一份备份；原文件将在下次保存时替换。");
    } catch (backupError) {
      if (primaryError.code !== "ENOENT" || backupError.code !== "ENOENT")
        throw new Error("工作区读取失败，且没有可用备份。请保留 data 目录后检查文件。", { cause: primaryError });
      workspace = createWorkspace();
      await atomicJson(workspaceFile, workspace, { backup: false });
    }
  }

  const persistedSettings = (next) => {
    const persisted = { ...next };
    if (!next.rememberKey) delete persisted.apiKey;
    else if (next.apiKey && secretCodec) {
      const ciphertext = secretCodec.encrypt(next.apiKey);
      if (typeof ciphertext !== "string" || !ciphertext)
        throw new Error("密钥加密失败。");
      persisted.encryptedApiKey = ciphertext;
      delete persisted.apiKey;
    }
    return persisted;
  };
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const stored = JSON.parse(await readFile(settingsFile, "utf8"));
    settings = checkedSettings(stored);
    if (!settings.rememberKey) delete settings.apiKey;
    else if (Object.hasOwn(stored, "encryptedApiKey")) {
      if (!secretCodec || typeof stored.encryptedApiKey !== "string")
        throw new Error("此密钥需要原桌面应用的系统密钥存储解密。");
      const plaintext = secretCodec.decrypt(stored.encryptedApiKey);
      if (typeof plaintext !== "string" || !plaintext.trim()) throw new Error("密钥解密失败。");
      settings = checkedSettings({ apiKey: plaintext }, settings);
    }
    // Migrate only after encryption succeeds. A failure leaves the original file intact.
    if (settings.rememberKey && settings.apiKey && secretCodec && Object.hasOwn(stored, "apiKey"))
      await atomicJson(settingsFile, persistedSettings(settings), { backup: false });
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("设置文件读取失败。请保留 settings.json 后检查密钥存储和文件内容。", { cause: error });
  }

  const visibleSettings = () => {
    const { apiKey, ...visible } = settings;
    return { ...visible, agentAvailable: allowAgent, hasApiKey: Boolean(apiKey), keyStorage: secretCodec ? "encrypted" : "plaintext", dataDirectory: dataDir };
  };
  let closed = false;
  let pendingWrite = Promise.resolve();
  const serialize = (operation) => {
    if (closed) throw new HttpError(503, "本地应用正在关闭。");
    const next = pendingWrite.then(operation);
    pendingWrite = next.catch(() => {});
    return next;
  };
  const activeRequests = new Set();
  let pendingBackground = Promise.resolve();
  const agentRuntime=createAgentRuntime({getSettings:()=>settings,available:allowAgent,fetchImpl,toolFactory:agentToolFactory,engines:agentEngines});

  const backgroundRequest = async (request, kind) => {
    const comparing = kind === "comparison";
    const label = comparing ? "比较" : "总结";
    const input = await readJson(request, MAX_WORKSPACE_BODY);
    let incoming;
    try { incoming = validateWorkspace(input.workspace); }
    catch (error) { throw new HttpError(400, error.message); }
    const board = incoming.boards.find((item) => item.id === input.boardId);
    if (!board) throw new HttpError(400, `找不到需要${label}的画布。`);
    if (comparing) {
      if (incoming.boards.length !== 1) throw new HttpError(400, "比较请求只应包含当前的一个画布。");
      try { getComparisonSources(board, input.nodeIds); }
      catch (error) { throw new HttpError(400, error.message); }
    } else if (typeof input.nodeId !== "string" || !board.nodes.some((node) => node.id === input.nodeId))
      throw new HttpError(400, "找不到需要总结的画布或会话。");
    if (closed) throw new HttpError(503, "本地应用正在关闭。");
    const current = { ...settings };
    const controller = new AbortController();
    let rejectCancelled;
    const cancelled = new Promise((_resolve, reject) => { rejectCancelled = reject; });
    // A queued cancellation must return immediately, even while another model job is busy.
    const abort = () => {
      controller.abort();
      rejectCancelled(new SummaryError(`${label}已取消或连接模型服务超时。`));
    };
    request.signal.addEventListener("abort", abort, { once: true });
    activeRequests.add(abort);
    if (request.signal.aborted || closed) abort();
    const complete = async (messages) => {
      if (controller.signal.aborted) throw new SummaryError(`${label}已取消或连接模型服务超时。`);
      const timer = setTimeout(abort, current.requestTimeoutSeconds * 1000);
      let rejectAbort;
      const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
      const rejectOnAbort = () => rejectAbort(new SummaryError(`${label}已取消或连接模型服务超时。`));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      let upstream;
      try {
        const fetching = Promise.resolve().then(() => fetchImpl(`${current.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(current.apiKey ? { Authorization: `Bearer ${current.apiKey}` } : {}) },
          body: JSON.stringify({ model: current.model, messages, temperature: 0.2, stream: false,
            ...(current.maxOutputTokens > 0 ? { max_tokens: current.maxOutputTokens } : {}) }),
          signal: controller.signal,
        }));
        // Also handle providers/mocks which resolve after cancellation without honouring fetch's signal.
        void fetching.then((response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        }).catch(() => {});
        upstream = await Promise.race([fetching, aborted]);
        return await Promise.race([readSummaryCompletion(upstream, controller.signal), aborted]);
      } catch (error) {
        if (error instanceof SummaryError) throw comparing ? new SummaryError(error.message.replaceAll("总结", "比较"), error.status) : error;
        throw new SummaryError(controller.signal.aborted
          ? `${label}已取消或连接模型服务超时。`
          : `无法连接模型服务生成${label}，请检查 API 地址及服务是否运行。`);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", rejectOnAbort);
      }
    };
    // Summaries and comparisons share one background model slot. Chat and disk
    // saves remain independent so the renderer can cancel/preempt background work.
    const job = pendingBackground.then(async () => {
      if (controller.signal.aborted || closed) throw new SummaryError(`${label}已取消或本地应用正在关闭。`);
      if (comparing) {
        const comparison = await generateComparison({ board, nodeIds: input.nodeIds, settings: current, complete, signal: controller.signal });
        return json(200, { comparison, boardId: board.id, nodeIds: [...input.nodeIds] });
      }
      const summary = await generateBranchSummary({ board, nodeId: input.nodeId, settings: current, complete, signal: controller.signal });
      return json(200, { summary, boardId: board.id, nodeId: input.nodeId });
    });
    pendingBackground = job.catch(() => {});
    try { return await Promise.race([job, cancelled]); }
    finally {
      request.signal.removeEventListener("abort", abort);
      activeRequests.delete(abort);
    }
  };

  const modelRequest = async (request, pathname) => {
    const input = pathname === "/api/models" && !request.body ? {} : await readJson(request);
    if (closed) throw new HttpError(503, "本地应用正在关闭。");
    const current = { ...settings };
    const messages = pathname === "/api/chat" ? checkedMessages(input) : null;
    if (messages && current.systemPrompt)
      messages.unshift({ role: "system", content: current.systemPrompt });
    const controller = new AbortController();
    let reader;
    let streaming = false;
    let cancelled = false;
    const abort = () => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      cleanup();
    };
    const timer = setTimeout(abort, current.requestTimeoutSeconds * 1000);
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      activeRequests.delete(abort);
    };
    activeRequests.add(abort);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted || closed) abort();
    try {
      const upstream = await fetchImpl(`${current.baseUrl}/${messages ? "chat/completions" : "models"}`, {
        method: messages ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(current.apiKey ? { Authorization: `Bearer ${current.apiKey}` } : {}),
        },
        ...(messages ? { body: JSON.stringify({ model: current.model, messages, temperature: current.temperature, stream: true,
          ...(current.maxOutputTokens > 0 ? { max_tokens: current.maxOutputTokens } : {}) }) } : {}),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new HttpError(502, `模型服务返回错误（HTTP ${upstream.status}）。请检查 API 地址、模型和密钥。`);
      }
      if (!messages) {
        const payload = await upstream.json();
        if (!Array.isArray(payload?.data))
          throw new HttpError(502, "模型服务未返回 OpenAI 兼容的模型列表。");
        return json(200, { models: [...new Set(payload.data.map((item) => item?.id).filter((id) => typeof id === "string" && id.length <= 256))] });
      }
      const responseType = (upstream.headers.get("content-type") || "").toLowerCase();
      if (responseType.includes("application/json")) {
        let payload;
        try { payload = await upstream.json(); }
        catch { throw new HttpError(502, "模型服务未返回有效的 JSON 回答。"); }
        const content = payload?.choices?.[0]?.message?.content;
        if (payload?.error || typeof content !== "string")
          throw new HttpError(502, "模型服务未返回 OpenAI 兼容的回答。请检查 API 地址、模型和密钥。");
        const usage = normalizeUsage(payload);
        return json(200, { choices: [{ message: { role: "assistant", content } }], ...(usage ? { usage } : {}) });
      }
      if (!upstream.body || !responseType.includes("text/event-stream")) {
        await upstream.body?.cancel();
        throw new HttpError(502, "模型服务未返回 OpenAI 兼容的流式或 JSON 回答。");
      }
      reader = upstream.body.getReader();
      if (controller.signal.aborted) {
        await reader.cancel();
        throw new Error("aborted");
      }
      const body = new ReadableStream({
        async pull(output) {
          try {
            const { value, done } = await reader.read();
            if (cancelled) return;
            if (controller.signal.aborted) throw new Error("aborted");
            if (done) { cleanup(); output.close(); return; }
            output.enqueue(value);
          } catch {
            if (cancelled) return;
            output.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error: "模型连接中断，请重试。" })}\n\n`));
            output.close();
            abort();
            cleanup();
          }
        },
        async cancel() {
          cancelled = true;
          abort();
          await reader.cancel().catch(() => {});
          cleanup();
        },
      });
      const response = new Response(body, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no",
        },
      });
      streaming = true;
      return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, controller.signal.aborted ? "连接模型服务超时或请求已取消。" : "无法连接模型服务，请检查 API 地址及服务是否运行。");
    } finally {
      if (!streaming) cleanup();
    }
  };

  return {
    async handle(request) {
      try {
        if (closed) throw new HttpError(503, "本地应用正在关闭。");
        let pathname;
        try { pathname = decodeURIComponent(new URL(request.url).pathname); }
        catch { throw new HttpError(400, "请求路径无效。"); }
        if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes(".."))
          throw new HttpError(403, "请求路径不被允许。");
        if (request.method === "GET" && pathname === "/api/health") return json(200, { ok: true });
        if (request.method === "GET" && pathname === "/api/workspace") return json(200, workspace);
        if (request.method === "PUT" && pathname === "/api/workspace") {
          let incoming;
          try { incoming = validateWorkspace(await readJson(request, MAX_WORKSPACE_BODY)); }
          catch (error) { throw error instanceof HttpError ? error : new HttpError(400, error.message); }
          const saved = await serialize(async () => {
            if (incoming.revision !== workspace.revision)
              throw new HttpError(409, "工作区已被其他窗口修改，请刷新后重试。");
            if (workspace.revision >= Number.MAX_SAFE_INTEGER)
              throw new HttpError(400, "工作区修订号已达到上限。");
            const next = { ...incoming, revision: workspace.revision + 1 };
            await atomicJson(workspaceFile, next, { backup: !recoveredBackup });
            recoveredBackup = false;
            workspace = next;
            return workspace;
          });
          return json(200, saved);
        }
        if (request.method === "GET" && pathname === "/api/settings") return json(200, visibleSettings());
        if (request.method === "PUT" && pathname === "/api/settings") {
          const input = await readJson(request);
          const visible = await serialize(async () => {
            if(!allowAgent&&input.agentEnabled&&!settings.agentEnabled)throw new HttpError(403,'Agent 执行只在桌面应用中提供。');
            if(agentRuntime.active&&Object.keys(input).some((key)=>key.startsWith('agent')))throw new HttpError(409,'请先停止 Agent，再修改执行设置。');
            const next = checkedSettings(input, settings);
            // No backup: opting out must remove the remembered secret from disk.
            await atomicJson(settingsFile, persistedSettings(next), { backup: false });
            settings = next;
            return visibleSettings();
          });
          return json(200, visible);
        }
        if (request.method === "POST" && ["/api/models", "/api/chat"].includes(pathname))
          return await modelRequest(request, pathname);
        if(request.method==='GET'&&pathname==='/api/agent/capabilities')return json(200,agentRuntime.capabilities());
        if(request.method==='POST'&&pathname==='/api/agent/run'){
          const input=await readJson(request);
          const messages=checkedMessages(input);
          return await agentRuntime.start({...input,messages},request.signal);
        }
        if(request.method==='POST'&&pathname==='/api/agent/approve')return json(200,agentRuntime.approve(await readJson(request)));
        if(request.method==='POST'&&pathname==='/api/agent/cancel')return json(200,await agentRuntime.cancel(await readJson(request)));
        if (request.method === "POST" && pathname === "/api/summarize") return await backgroundRequest(request, "summary");
        if (request.method === "POST" && pathname === "/api/compare") return await backgroundRequest(request, "comparison");
        throw new HttpError(404, "API 不存在或请求方法不支持。");
      } catch (error) {
        const knownError = error instanceof HttpError || error instanceof SummaryError || error instanceof AgentError;
        return json(knownError ? error.status : 500, {
          error: knownError ? error.message : "本地应用读取或保存失败，请检查磁盘权限与可用空间。",
        });
      }
    },
    async close() {
      closed = true;
      for (const abort of activeRequests) abort();
      await Promise.all([pendingWrite, pendingBackground, agentRuntime.close()]);
    },
  };
}
