// Run with: node node_modules/electron/cli.js tests/branches-desktop-smoke.mjs
// Owns a hidden Electron window, temporary data, and deterministic model/image fixtures.
import { app, BrowserWindow, Menu, ipcMain, protocol } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLocalService } from "../server/service.mjs";
import { buildContext, createBoard, createNode, newId } from "../shared/core.mjs";
import { assetFilename, isAppUrl } from "../desktop/security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "branch-relations-smoke-"));
const profileDir = path.join(temporary, "profile"), dataDir = path.join(temporary, "data");
mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "branch-local", privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
app.on("window-all-closed", () => {});
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const imageUrl = "https://images.branch-smoke.example/diagram.svg";
const needle = "缓存前缀保持一致";
const report = { windowVisible: false, rendererErrors: [], resourceErrors: [], providerCalls: [], imageRequests: [], blockedExternalRequests: [], checks: {}, screenshots: [] };
const artifacts = path.join(root, "artifacts");
let service, window, finishing = false, stage = "app readiness";
const evaluate = (source) => window.webContents.executeJavaScript(source);
const selector = (value) => JSON.stringify(value);
const card = (id) => `.node-card[data-node-id="${id}"]`;
async function waitFor(expression, label, timeout = 10000) {
  stage = label;
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error(`Renderer condition was not met: ${label}`);
}
async function screenshot(filename) {
  await evaluate("document.fonts.ready");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(path.join(artifacts, filename), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  report.screenshots.push(filename);
}
async function api(pathname, payload) {
  const response = await service.handle(new Request(`branch-local://app${pathname}`, payload ? {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  } : {}));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function saved(expression, label) {
  await waitFor(`(async()=>{const ws=await(await fetch('/api/workspace')).json();const b=ws.boards[0];return ${expression};})()`, label);
  return (await api("/api/workspace")).boards[0];
}
async function openNode(id) {
  await evaluate(`document.querySelector(${selector(card(id))}).click()`);
  await waitFor(`Boolean(document.querySelector('.chat-panel')) && document.querySelector(${selector(card(id))})?.classList.contains('selected')`, "conversation opens");
}
async function setTextarea(css, value) {
  await evaluate(`(()=>{const input=document.querySelector(${selector(css)}); input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function overview() {
  if (!await evaluate("Boolean(document.querySelector('.conversation-overview'))"))
    await evaluate("document.querySelector('[data-conversation-overview-toggle]').click()");
  await waitFor("Boolean(document.querySelector('.conversation-overview'))", "conversation overview opens");
}
async function conversationAction(action) {
  await evaluate("document.querySelector('[aria-label=\"会话更多操作\"]').click()");
  await waitFor(`Boolean(document.querySelector('.context-menu [data-action="${action}"]'))`, `conversation ${action} menu opens`);
  await evaluate(`(()=>{const button=document.querySelector('.context-menu [data-action="${action}"]');button.focus();button.click();})()`);
}
async function finish(code, error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  report.ok = code === 0; report.stage = stage;
  if (error) report.error = error.stack || String(error);
  try {
    if (window && !window.isDestroyed()) {
      if (error) await screenshot("branches-smoke-failure.png").catch(() => {});
      assert.equal(window.isVisible(), false);
      window.destroy();
    }
    await service?.close();
    await mkdir(artifacts, { recursive: true });
    report.profileCleanup = "scheduled after the owned Electron process exits";
    await writeFile(path.join(artifacts, "branches-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("branch-relations-smoke-"));
    const cleanup = `
      const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
      const [directory,parent]=process.argv.slice(1),resolved=path.resolve(directory);
      if(path.dirname(resolved).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith('branch-relations-smoke-'))process.exit(2);
      (async()=>{for(let i=0;i<400;i++){try{process.kill(Number(parent),0);}catch{await fs.rm(resolved,{recursive:true,force:true,maxRetries:30,retryDelay:100});return;}await new Promise(r=>setTimeout(r,50));}process.exitCode=3;})().catch(()=>{process.exitCode=4;});
    `;
    const helper = spawn(process.execPath, ["-e", cleanup, resolved, String(process.pid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore", detached: true,
    });
    helper.on("error", (failure) => console.error("Owned profile cleanup could not start:", failure.message));
    helper.unref();
  } catch (failure) { console.error("Branch smoke cleanup failed:", failure); code = 1; }
  app.exit(code);
}
const deadline = setTimeout(() => void finish(1, new Error(`Branch renderer smoke timed out during ${stage}`)), 60000);

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
    const dist = await realpath(path.join(root, "dist"));
    await mkdir(artifacts, { recursive: true });
    const board = createBoard("精确分支与会话概览验收");
    const first = board.nodes[0]; first.title = "主干 A：上下文与分支"; first.x = 65; first.y = 90;
    const originalAnswer = `第一处：**${needle}**，原始记录不受分支影响。\n\n第二处：**${needle}**，在这里深入分析缓存。\n\n| 模式 | 上下文 |\n| --- | --- |\n| branch | 共享前缀 |\n| merge | 追加差异 |\n\n公式 $x^2+1$。参考[协议文档](https://docs.branch-smoke.example/guide)。\n\n![上下文结构图](${imageUrl})\n\n![旧 HTTP 资料](http://images.branch-smoke.example/legacy.png)`;
    first.messages = [
      { id: newId(), role: "user", content: "解释 branch 与 merge 如何保存原始对话和上下文。", createdAt: new Date().toISOString() },
      { id: newId(), role: "assistant", content: originalAnswer, createdAt: new Date().toISOString() },
    ];
    const originalPrefix = first.messages.map(({ role, content }) => ({ role, content }));
    const assistantId = first.messages[1].id;
    const other = createNode(board, { title: "独立 B：安全检查" }); other.x = 500; other.y = 90;
    other.messages = [
      { id: newId(), role: "user", content: "如何避免把历史来源当成新的系统指令？", createdAt: new Date().toISOString() },
      { id: newId(), role: "assistant", content: "把差异内容作为有明确出处的引用资料追加，由当前问题决定如何使用。", createdAt: new Date().toISOString() },
    ];
    service = await createLocalService({ dataDir, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      report.providerCalls.push({ url, body });
      assert.equal(url, "https://branch-smoke.example.invalid/v1/chat/completions");
      assert.equal(body.model, "branch-smoke-model");
      const content = body.stream === false
        ? JSON.stringify({ title: "缓存分支：前缀稳定性", summary: "此叶子分支聚焦第二处缓存前缀的一致性，保留原始主干并区分表格、图片与其他来源。" })
        : "**已保留前缀**。分支聚焦当前引文，$x^2$ 已按公式渲染。";
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 123, completion_tokens: 23, prompt_tokens_details: { cached_tokens: 100 } } }),
      { headers: { "Content-Type": "application/json" } });
    } });
    await api("/api/workspace", { version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
    await api("/api/settings", { autoSummary: false, reduceMotion: true, theme: "light", showMinimap: false,
      baseUrl: "https://branch-smoke.example.invalid/v1", model: "branch-smoke-model" });
    // Intercept every browser HTTP(S) request. The only permitted image is a
    // locally generated fixture; no real model, webpage, or image is fetched.
    protocol.handle("https", async (request) => {
      if (request.url === imageUrl) {
        report.imageRequests.push(request.url);
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="100"><rect width="420" height="100" rx="15" fill="#ecf3ea"/><text x="24" y="58" fill="#34573b" font-size="22">Local image fixture: branch → merge</text></svg>', { headers: { "Content-Type": "image/svg+xml" } });
      }
      report.blockedExternalRequests.push(request.url);
      return new Response("External requests are disabled in this test", { status: 403 });
    });
    protocol.handle("http", (request) => {
      report.blockedExternalRequests.push(request.url);
      return new Response("HTTP requests are disabled in this test", { status: 403 });
    });
    protocol.handle("branch-local", async (request) => {
      if (!isAppUrl(request.url)) return new Response("Forbidden", { status: 403 });
      if (new URL(request.url).pathname.startsWith("/api/")) return service.handle(request);
      try {
        const filename = await realpath(assetFilename(dist, request.url)), relative = path.relative(dist, filename);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Forbidden", { status: 403 });
        return new Response(await readFile(filename), { headers: { "Content-Type": MIME[path.extname(filename)] || "application/octet-stream", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" } });
      } catch (error) { report.resourceErrors.push({ url: request.url, error: error.message }); return new Response("Not found", { status: 404 }); }
    });
    ipcMain.handle("desktop:state", () => ({ maximized: false }));
    ipcMain.handle("desktop:window", () => {});
    ipcMain.on("desktop:renderer-ready", () => { report.preloadReady = true; });
    ipcMain.on("desktop:application-ready", () => { report.applicationReady = true; });
    window = new BrowserWindow({ show: false, width: 1600, height: 1100, frame: false,
      webPreferences: { preload: path.join(root, "desktop", "preload.cjs"), sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === 3) report.rendererErrors.push(details.message);
    });
    await window.loadURL("branch-local://app/");
    await waitFor("document.querySelectorAll('.node-card').length===2 && Boolean(window.branchDesktop)", "isolated renderer opens");
    await openNode(first.id);
    assert.equal(await evaluate("document.querySelectorAll('.message-content img').length"), 0);
    assert.equal(report.imageRequests.length, 0);
    assert.equal(await evaluate("document.querySelectorAll('.message-content strong').length>=2 && Boolean(document.querySelector('.katex'))"), true);
    await evaluate(`(()=>{
      const body=document.querySelector('.message-body[data-message-id="${assistantId}"]');
      const paragraph=[...body.querySelectorAll('p')].find(p=>p.textContent.startsWith('第二处'));
      const text=paragraph.querySelector('strong').firstChild;
      const range=document.createRange();range.setStart(text,0);range.setEnd(text,text.length);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      body.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:900,clientY:250}));
    })()`);
    await waitFor("Boolean(document.querySelector('.quote-popover'))", "actual repeated text selection opens branch control");
    await evaluate("document.querySelector('.quote-popover').click()");
    let current = await saved("b.nodes.length===3", "text branch persists");
    const textChild = current.nodes.find((node) => ![first.id, other.id].includes(node.id));
    assert.equal(textChild.parentId, first.id);
    assert.equal(textChild.source.quote, needle);
    assert.equal(textChild.source.anchor.kind, "text");
    assert.equal(textChild.source.anchor.occurrence, 1);
    assert.equal(textChild.source.messageId, assistantId);
    assert.equal(textChild.source.contextMode, "tail-focus");
    assert.deepEqual(textChild.source.context, originalPrefix);
    await setTextarea('textarea[aria-label="输入消息"]', "请解释这个缓存分支的具体影响。");
    await waitFor("!document.querySelector('.send-button').disabled", "branch question enters composer");
    await evaluate("document.querySelector('.send-button').click()");
    current = await saved(`b.nodes.find(n=>n.id===${selector(textChild.id)}).messages.length===2 && !document.querySelector('.send-button.stop')`, "first branch answer and usage persist");
    const chatCall = report.providerCalls.find((call) => call.body.stream === true);
    assert.ok(chatCall);
    assert.deepEqual(chatCall.body.messages.slice(0, 2), originalPrefix);
    assert.match(chatCall.body.messages.at(-1).content, new RegExp(needle));
    assert.match(chatCall.body.messages.at(-1).content, /请解释这个缓存分支/);
    await overview();
    await evaluate("document.querySelector('.overview-refresh').click()");
    await waitFor("document.querySelector('.overview-summary-title')?.textContent==='缓存分支：前缀稳定性'", "selected mock provider generates real overview summary");
    assert.equal(await evaluate("document.querySelectorAll('.overview-sources li').length"), 3);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.overview-usage dd')].map(el=>el.textContent)"), ["123", "100", "23"]);
    assert.match(await evaluate("document.querySelector('.overview-metadata').textContent"), /branch-smoke-model/);
    report.checks.textBranch = { repeatedOccurrence: 1, originalPrefixPreserved: true, tailFocusedQuestion: true, reportedUsage: [123, 100, 23], sourcesFromTranscriptOnly: 3 };
    await screenshot("branches-smoke-overview.png");
    await evaluate("document.querySelector('.overview-jump').click()");
    await waitFor("Boolean(CSS.highlights.get('branch-origin'))", "source jump creates exact rendered text highlight");
    const selection = await evaluate("(()=>{const range=[...CSS.highlights.get('branch-origin')][0];return {text:range.toString(),paragraph:range.startContainer.parentElement.closest('p').textContent};})()");
    assert.equal(selection.text, needle); assert.match(selection.paragraph, /^第二处/);
    assert.equal(await evaluate(`document.querySelector('[data-open-branch="${textChild.id}"]').closest('.message-text-branch-tools').previousElementSibling.textContent.startsWith('第二处')`), true);
    await screenshot("branches-smoke-text-origin.png");
    await evaluate("document.querySelector('[data-branch-block=table]').click()");
    current = await saved("b.nodes.length===4", "table branch persists");
    const tableChild = current.nodes.find((node) => node.source?.anchor?.kind === "table");
    assert.equal(tableChild.source.anchor.blockIndex, 0); assert.match(tableChild.source.quote, /branch \| 共享前缀/);
    await openNode(first.id);
    assert.equal(await evaluate(`Boolean(document.querySelector('table').nextElementSibling.querySelector('[data-open-branch="${tableChild.id}"]'))`), true);
    await evaluate("document.querySelector('[data-branch-block=image]').click()");
    current = await saved("b.nodes.length===5", "image branch persists");
    const imageChild = current.nodes.find((node) => node.source?.anchor?.kind === "image");
    assert.equal(imageChild.source.anchor.blockIndex, 0); assert.equal(imageChild.source.anchor.imageUrl, imageUrl);
    await openNode(first.id);
    assert.equal(report.imageRequests.length, 0);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-image-ref="${imageUrl}"] [data-open-branch="${imageChild.id}"]'))`), true);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-image-ref^=\"http:\"] [data-load-image]'))"), false);
    await screenshot("branches-smoke-block-links.png");
    await evaluate("(()=>{const button=document.querySelector('[data-load-image]');button.scrollIntoView({block:'center'});button.click();})()");
    await waitFor("document.querySelector('.message-loaded-image')?.naturalWidth===420", "explicit image load resolves local intercepted fixture");
    assert.deepEqual(report.imageRequests, [imageUrl]);
    report.checks.blockBranches = { table: tableChild.id, image: imageChild.id, localLinks: true, noAutomaticImageFetch: true, explicitImageFixture: true, httpImageExternalOnly: true };
    await screenshot("branches-smoke-image.png");
    await conversationAction('merge');
    await waitFor("Boolean(document.querySelector('input[name=mergeMode]'))", "merge choices open");
    await evaluate(`document.querySelector('input[aria-label="选择会话：${other.title}"]').click();document.querySelector('input[name=mergeMode][value=append]').click();document.querySelector('.dialog-actions .primary').click()`);
    current = await saved(`b.nodes.find(n=>n.id===${selector(first.id)}).merges.some(r=>r.nodeId===${selector(other.id)})`, "append merge persists on existing trunk");
    assert.equal(current.nodes.length, 5);
    const appended = current.nodes.find((node) => node.id === first.id);
    assert.deepEqual(appended.messages.slice(0, 2).map(({ role, content }) => ({ role, content })), originalPrefix);
    assert.deepEqual(current.nodes.find((node) => node.id === other.id).messages, other.messages);
    await overview();
    assert.equal(await evaluate(`Boolean([...document.querySelectorAll('.overview-node-link')].find(el=>el.textContent.includes(${JSON.stringify(other.title)})))`), true);
    await screenshot("branches-smoke-merge-overview.png");
    await evaluate("document.querySelector('.overview-close').click()");
    await conversationAction('merge');
    await waitFor("Boolean(document.querySelector('input[name=mergeMode]'))", "new merge choices open");
    await evaluate(`document.querySelector('input[aria-label="选择会话：${other.title}"]').click();document.querySelector('input[name=mergeMode][value=new]').click();document.querySelector('.dialog-actions .primary').click()`);
    const prefixBeforeMerge = buildContext(current, first.id);
    current = await saved("b.nodes.length===6", "new merge creates independent conversation");
    const newMerge = current.nodes.find((node) => node.mergeParents?.includes(other.id));
    assert.ok(newMerge); assert.equal(newMerge.parentId, first.id);
    assert.deepEqual(newMerge.source.context, prefixBeforeMerge);
    assert.deepEqual(current.nodes.find((node) => node.id === first.id).messages, appended.messages);
    report.checks.merges = { appendRetainsIdentity: true, originalMessagePrefixUnchanged: true, sourceUnchanged: true, newMergeRetainsPrimaryContext: true };
    await openNode(first.id);
    await evaluate(`document.querySelector('.message[data-message-id="${assistantId}"] [aria-label="编辑消息"]').click()`);
    await setTextarea('textarea[aria-label="修改消息内容"]', "此消息已编辑：原来的引用不在当前内容中。");
    await evaluate("document.querySelector('.message-editor .primary').click()");
    await saved(`b.nodes.find(n=>n.id===${selector(first.id)}).messages[1].content.startsWith('此消息已编辑')`, "edited parent persists");
    await openNode(textChild.id);
    await overview();
    await evaluate("document.querySelector('.overview-jump').click()");
    await waitFor("Boolean(document.querySelector('.source-snapshot'))", "edited source opens historical snapshot instead of false precise jump");
    assert.match(await evaluate("document.querySelector('.source-snapshot').textContent"), new RegExp(needle));
    assert.match(await evaluate("document.querySelector('.modal .dialog-description')?.textContent || document.querySelector('.dialog-description').textContent"), /后来被编辑/);
    report.checks.editedAnchor = { preservedSnapshot: true, noFalsePreciseJump: true };
    await screenshot("branches-smoke-edited-source.png");
    assert.ok(report.providerCalls.some((call) => call.body.stream === false));
    assert.deepEqual(report.blockedExternalRequests, []);
    assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.resourceErrors, []);
    assert.equal(window.isVisible(), false);
    stage = "complete";
    console.log("Hidden branch renderer smoke passed: precise repeated-text/table/image branches, local block links, explicit image loading, real-provider overview and usage, append/new merges, edited-source snapshot. Artifacts: artifacts/branches-smoke*.png/json");
    await finish(0);
  } catch (error) { console.error(`Branch renderer smoke failed during ${stage}:`, error); await finish(1, error); }
});
