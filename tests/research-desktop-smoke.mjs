// Run with Electron. This owns a hidden window, an isolated profile and local fixtures.
import { app, BrowserWindow, Menu, ipcMain, protocol, safeStorage } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLocalService } from "../server/service.mjs";
import { createBoard, createNode, newId } from "../shared/core.mjs";
import { createConclusion } from "../shared/research.mjs";
import { assetFilename, isAppUrl } from "../desktop/security.mjs";
import { readMaterialDocuments } from "../desktop/materials.mjs";
import { tinyMaterialPdf } from "./materials-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "branch-research-smoke-"));
const profileDir = path.join(temporary, "profile"), dataDir = path.join(temporary, "data");
mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "branch-local", privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
app.on("window-all-closed", () => {});
const artifacts = path.join(root, "artifacts");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const report = { windowVisible: false, isolatedSyntheticData: true, rendererErrors: [], resourceErrors: [],
  blockedExternalRequests: [], providerCalls: [], comparisonResponses: [], importCalls: 0, checks: {}, screenshots: [] };
const agreement = "文件替换和事务提交都需要明确的提交边界。";
const reviewedAgreement = `${agreement}\n\n**人工审阅备注**：需要验证异常中断的边界。`;
const openQuestion = "异常中断前后的可恢复性还需要实验验证。";
const otherConclusion = "UNSELECTED_CONFIRMED_CARD_MUST_NOT_LEAK";
const title = "原子提交的研究结论";
let service, window, finishing = false, stage = "app readiness";
const evaluate = (source) => window.webContents.executeJavaScript(source);
const js = (value) => JSON.stringify(value);
const card = (id) => `.node-card[data-node-id="${id}"]`;

async function waitFor(expression, label, timeout = 10000) {
  stage = label;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error(`Renderer condition was not met: ${label}`);
}
async function click(css) {
  await evaluate(`(()=>{const target=document.querySelector(${js(css)});if(!target)throw new Error('Missing element: '+${js(css)});target.click();})()`);
}
async function clickText(scope, text) {
  await evaluate(`(()=>{const parent=document.querySelector(${js(scope)});const target=[...parent.querySelectorAll('button')].find(button=>button.textContent.includes(${js(text)}));if(!target)throw new Error('Missing button: '+${js(text)});target.click();})()`);
}
async function checkLabel(scope, text) {
  await evaluate(`(()=>{const parent=document.querySelector(${js(scope)});const target=[...parent.querySelectorAll('label')].find(label=>label.textContent.includes(${js(text)}))?.querySelector('input');if(!target)throw new Error('Missing checkbox: '+${js(text)});target.click();})()`);
}
async function setText(css, value) {
  await evaluate(`(()=>{const input=document.querySelector(${js(css)});if(!input)throw new Error('Missing input');input.focus();
    const type=input.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;
    Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(input,${js(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function api(pathname, payload) {
  const response = await service.handle(new Request(`branch-local://app${pathname}`, payload ? {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  } : {}));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function saved(expression, label) {
  await waitFor(`(async()=>{const workspace=await(await fetch('/api/workspace')).json();const board=workspace.boards[0];return ${expression};})()`, label);
  return (await api("/api/workspace")).boards[0];
}
async function openNode(id) {
  await click(card(id));
  await waitFor(`Boolean(document.querySelector('.chat-panel'))&&document.querySelector(${js(card(id))})?.classList.contains('selected')`, "target conversation opens");
}
async function closeModal() {
  await click('.modal-heading [aria-label="关闭弹窗"]');
  await waitFor("!document.querySelector('.modal-shade')", "modal closes");
}
async function screenshot(filename) {
  await evaluate("document.fonts.ready");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await writeFile(path.join(artifacts, filename), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  report.screenshots.push(filename);
}
async function previewMessages() {
  return evaluate("[...document.querySelectorAll('.request-preview>details')].map(detail=>({role:detail.querySelector('summary').textContent.match(/^\\d+\\.\\s+(\\w+)/)[1],content:detail.querySelector('pre').textContent}))");
}
async function preview() {
  await clickText(".context-picker", "预览实际请求内容");
  await waitFor("Boolean(document.querySelector('.request-preview'))", "actual request preview opens");
  await evaluate("document.querySelectorAll('.request-preview>details').forEach(detail=>detail.open=true)");
  return previewMessages();
}
async function finish(code, error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  report.ok = code === 0;
  report.stage = stage;
  if (error) report.error = error.stack || String(error);
  try {
    if (window && !window.isDestroyed()) {
      if (error) await screenshot("research-smoke-failure.png").catch(() => {});
      assert.equal(window.isVisible(), false);
      window.destroy();
    }
    await service?.close();
    await mkdir(artifacts, { recursive: true });
    report.profileCleanup = "scheduled after the owned Electron process exits";
    await writeFile(path.join(artifacts, "research-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("branch-research-smoke-"));
    const cleanup = `
      const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
      const [directory,parent]=process.argv.slice(1),resolved=path.resolve(directory);
      if(path.dirname(resolved).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith('branch-research-smoke-'))process.exit(2);
      (async()=>{for(let i=0;i<400;i++){try{process.kill(Number(parent),0);}catch{await fs.rm(resolved,{recursive:true,force:true,maxRetries:30,retryDelay:100});return;}await new Promise(r=>setTimeout(r,50));}process.exitCode=3;})().catch(()=>{process.exitCode=4;});
    `;
    const helper = spawn(process.execPath, ["-e", cleanup, resolved, String(process.pid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore", detached: true,
    });
    helper.on("error", (failure) => console.error("Owned test profile cleanup could not start:", failure.message));
    helper.unref();
  } catch (failure) { console.error("Research smoke cleanup failed:", failure); code = 1; }
  app.exit(code);
}
const deadline = setTimeout(() => void finish(1, new Error(`Hidden research smoke timed out during ${stage}`)), 90000);

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
    const dist = await realpath(path.join(root, "dist"));
    await mkdir(artifacts, { recursive: true });
    const board = createBoard("可追溯的研究工作台 · 离线验收");
    const trunk = board.nodes[0]; trunk.title = "主线：原子保存的条件";
    const createdAt = "2026-10-17T08:00:00.000Z";
    const message = (role, content) => ({ id: newId(), role, content, createdAt });
    trunk.messages = [message("user", "比较原子保存的实现条件。"), message("assistant", "共同起点：保存必须区分准备阶段与提交阶段。")];
    const left = createNode(board, { parentId: trunk.id, title: "文件方案", quote: "准备阶段与提交阶段" });
    left.messages = [message("user", "文件保存的失败条件有哪些？"), message("assistant", "文件方案通过 rename 原子替换文件，避免先删除仍然有效的旧数据。")];
    const right = createNode(board, { parentId: trunk.id, title: "事务方案" });
    right.messages = [message("user", "事务如何确定保存成功？"), message("assistant", "事务需要 commit 后才对外可见，失败后可以回滚未提交的修改。")];
    const seed = createConclusion({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] }, {
      boardId: board.id, nodeIds: [left.id, right.id], title: "另一张独立结论卡", createdAt,
      items: [{ id: newId(), category: "conclusion", text: otherConclusion,
        citations: [{ nodeId: right.id, messageId: right.messages[1].id, quote: "事务需要 commit 后才对外可见" }] }],
    });
    seed.workspace.boards[0].nodes.find((node) => node.id === seed.nodeId).conclusion.items[0].adopted = true;
    const materialPdf = path.join(temporary, "local-research-reference.pdf");
    const materialMarkdown = path.join(temporary, "本地研究笔记.md");
    await writeFile(materialPdf, tinyMaterialPdf([{ lines: ["Local PDF evidence on page one."] }, { lines: ["Local PDF evidence on page two."] }]));
    await writeFile(materialMarkdown, "# 本地研究笔记\n\n这里只保存用户选择的资料文字。\n", "utf8");
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    service = await createLocalService({ dataDir,
      secretCodec: { encrypt: (value) => safeStorage.encryptString(value).toString("base64"), decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")) },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const kind = body.stream === false ? "compare" : "chat";
        report.providerCalls.push({ kind, url, body });
        assert.equal(url, "https://research-smoke.example.invalid/v1/chat/completions");
        assert.equal(body.model, "research-smoke-model");
        let content;
        if (kind === "compare") {
          assert.doesNotMatch(JSON.stringify(body.messages), new RegExp(otherConclusion));
          content = JSON.stringify({ title, items: [
            { category: "agreement", text: agreement, verified: true, adopted: true,
              citations: [{ nodeId: left.id, messageId: left.messages[1].id, quote: "通过 rename 原子替换文件" }] },
            { category: "difference", text: "文件路径与数据库事务的恢复机制不同。", verified: true, adopted: true,
              citations: [{ nodeId: right.id, messageId: right.messages[1].id, quote: "事务需要 commit 后才对外可见" }] },
            { category: "open", text: openQuestion, verified: true, adopted: true,
              citations: [{ nodeId: left.id, contextIndex: 0, quote: "比较原子保存的实现条件。" }] },
          ] });
        } else content = `本地模型测试回答 ${report.providerCalls.filter((call) => call.kind === "chat").length}：只使用实际发送的研究资料。`;
        return Response.json({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 80, completion_tokens: 20 } });
      },
    });
    await api("/api/workspace", seed.workspace);
    await api("/api/settings", { autoSummary: false, reduceMotion: true, theme: "light", showMinimap: false,
      baseUrl: "https://research-smoke.example.invalid/v1", model: "research-smoke-model", systemPrompt: "离线研究验收：仅按用户选择的资料回答。" });
    for (const scheme of ["http", "https"]) protocol.handle(scheme, (request) => {
      report.blockedExternalRequests.push(request.url);
      return new Response("External requests are disabled in this test", { status: 403 });
    });
    protocol.handle("branch-local", async (request) => {
      if (!isAppUrl(request.url)) return new Response("Forbidden", { status: 403 });
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith("/api/")) {
        const response = await service.handle(request);
        if (pathname === "/api/compare" && response.ok) report.comparisonResponses.push((await response.clone().json()).comparison);
        return response;
      }
      try {
        const filename = await realpath(assetFilename(dist, request.url)), relative = path.relative(dist, filename);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Forbidden", { status: 403 });
        return new Response(await readFile(filename), { headers: { "Content-Type": MIME[path.extname(filename)] || "application/octet-stream", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" } });
      } catch (error) { report.resourceErrors.push({ url: request.url, error: error.message }); return new Response("Not found", { status: 404 }); }
    });
    const assertSender = (event) => assert.ok(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url));
    ipcMain.handle("desktop:state", () => ({ maximized: false }));
    ipcMain.handle("desktop:window", () => {});
    ipcMain.handle("desktop:copy-text", (event) => assertSender(event));
    ipcMain.handle("desktop:import-materials", async (event) => {
      assertSender(event);
      report.importCalls += 1;
      const documents = await readMaterialDocuments([materialPdf, materialMarkdown]);
      return { canceled: false, documents };
    });
    ipcMain.on("desktop:renderer-ready", () => { report.preloadReady = true; });
    ipcMain.on("desktop:application-ready", () => { report.applicationReady = true; });
    window = new BrowserWindow({ show: false, width: 1600, height: 1100, frame: false,
      webPreferences: { preload: path.join(root, "desktop", "preload.cjs"), sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === 3) report.rendererErrors.push(details.message);
    });
    await window.loadURL("branch-local://app/");
    await waitFor("document.querySelectorAll('.node-card').length===4&&Boolean(window.branchDesktop?.importMaterials)", "isolated app and actual sandbox preload open");
    await openNode(left.id);
    await evaluate("(()=>{const select=document.querySelector('.chat-panel select[aria-label=\"研究状态\"]');select.value='verify';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await saved(`board.nodes.find(node=>node.id===${js(left.id)}).researchStatus==='verify'`, "manual research status persists");
    await click('[aria-label="比较分支"]');
    await waitFor("Boolean(document.querySelector('.comparison-workbench'))", "comparison workbench opens");
    await click(`input[aria-label="比较分支：${right.title}"]`);
    await clickText(".comparison-actions", "生成比较");
    await waitFor("document.querySelectorAll('.comparison-item').length===3&&!document.querySelector('.comparison-actions .button')?.disabled", "configured mock provider returns real validated comparison");
    assert.equal(report.comparisonResponses.length, 1);
    assert.ok(report.comparisonResponses[0].items.every((item) => item.verified === false && item.adopted === false && item.citations.length === 1));
    assert.equal(await evaluate("document.querySelectorAll('.comparison-results .conclusion-confirmations input:checked').length"), 0);
    await click(".comparison-item .evidence-link");
    await waitFor("Boolean(document.querySelector('.evidence-preview'))", "comparison citation previews inline");
    assert.match(await evaluate("document.querySelector('.evidence-preview').textContent"), /通过 rename 原子替换文件/);
    await screenshot("research-smoke-comparison.png");
    await clickText(".evidence-preview", "打开来源位置");
    await waitFor("!document.querySelector('.modal-shade')&&Boolean(CSS.highlights.get('branch-origin'))", "comparison citation jumps to real source highlight");
    assert.equal(await evaluate("[...CSS.highlights.get('branch-origin')][0].toString()"), "通过 rename 原子替换文件");
    await click('[aria-label="比较分支"]');
    await waitFor("document.querySelectorAll('.comparison-item').length===3", "review draft survives source navigation");
    assert.equal(await evaluate("document.querySelectorAll('.comparison-item textarea').length"),0);
    await click('.comparison-item .comparison-edit');
    await setText('.comparison-item textarea',reviewedAgreement);
    await click('.comparison-item .comparison-edit');
    await waitFor("!document.querySelector('.comparison-item textarea')&&Boolean(document.querySelector('.comparison-item .message-content strong'))", "explicit comparison editor returns to rendered reading mode");
    await checkLabel(".comparison-item", "我决定采用");
    await clickText(".comparison-save", "确认并保存结论卡");
    let current = await saved(`board.nodes.some(node=>node.kind==='conclusion'&&node.title===${js(title)})&&!document.querySelector('.modal-shade')`, "reviewed conclusion card persists");
    const conclusion = current.nodes.find((node) => node.kind === "conclusion" && node.title === title);
    assert.equal(conclusion.conclusion.items.filter((item) => item.adopted).length, 1);
    assert.equal(conclusion.conclusion.items.filter((item) => item.verified).length, 0);
    assert.deepEqual(conclusion.conclusion.sourceNodeIds, [left.id, right.id]);
    assert.equal(conclusion.conclusion.items[0].text, reviewedAgreement);
    assert.equal(conclusion.messages[0].role, "assistant");
    await waitFor("Boolean(document.querySelector('.conclusion-view'))&&document.querySelector('.chat-scroll')?.scrollTop===0", "saved conclusion opens at the beginning for review");
    assert.equal(await evaluate("Boolean(document.querySelector('.chat-panel .chat-summary'))"), false);
    report.checks.comparison = { realServiceValidation: true, aiFlagsReset: true, humanAdoptionPersisted: true, sourceNodeIds: conclusion.conclusion.sourceNodeIds };
    assert.equal(await evaluate("document.querySelectorAll('.conclusion-view textarea').length"),0);
    assert.equal(await evaluate("document.querySelector('.conclusion-view .message-content strong')?.textContent"),'人工审阅备注');
    report.checks.conclusionReading = { startsAtTop: true, noDuplicateSummaryPrompt: true, renderedDefault: true };
    await screenshot("research-smoke-conclusion.png");
    await click('.conclusion-view .conclusion-edit');
    await setText('.conclusion-view textarea',`${reviewedAgreement}\n\n待取消文本`);
    await evaluate("document.querySelector('.conclusion-view textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await waitFor("!document.querySelector('.conclusion-view textarea')", "Escape closes explicit conclusion editor");
    assert.doesNotMatch(await evaluate("document.querySelector('.conclusion-view').textContent"),/待取消文本/);
    report.checks.conclusionReading.explicitEditorCancelsWithoutSaving=true;
    await click(".conclusion-view .evidence-link");
    await clickText(".conclusion-view .evidence-preview", "打开来源位置");
    await waitFor(`document.querySelector(${js(card(left.id))})?.classList.contains('selected')&&Boolean(CSS.highlights.get('branch-origin'))`, "saved conclusion evidence returns to original conversation");
    await screenshot("research-smoke-evidence-origin.png");
    report.checks.evidenceJump = { comparisonAndSavedCard: true, exactQuote: "通过 rename 原子替换文件" };
    await click('[aria-label="研究进展"]');
    await waitFor("Boolean(document.querySelector('.research-resume'))", "local research progress opens");
    assert.match(await evaluate("document.querySelector('.research-resume').textContent"), new RegExp(agreement));
    assert.match(await evaluate("document.querySelector('.research-resume').textContent"), new RegExp(openQuestion));
    assert.match(await evaluate("document.querySelector('.research-resume').textContent"), /待验证/);
    await screenshot("research-smoke-resume.png");
    await evaluate(`(()=>{const entry=[...document.querySelectorAll('.resume-item')].find(item=>item.textContent.includes('待验证')&&item.textContent.includes(${js(left.title)}));if(!entry)throw new Error('Missing waiting research entry');entry.click();})()`);
    await waitFor("!document.querySelector('.modal-shade')", "progress navigates back to waiting source");
    report.checks.resume = { confirmedAndOpenFromLocalRecords: true, manualStatus: "verify", navigation: true };

    await setText('textarea[aria-label="输入消息"]', "请仅依据所选的历史回答这次问题。");
    await click(".composer-context-button");
    await waitFor("Boolean(document.querySelector('.context-picker'))", "request context selection opens");
    await click('input[name="contextMode"][value="selected"]');
    await checkLabel(".context-entry-list", "共同起点");
    await checkLabel(".context-entry-list", "文件方案通过 rename");
    const selectedPreview = await preview();
    await screenshot("research-smoke-context-selected.png");
    await clickText(".context-picker .dialog-actions", "使用此上下文");
    await waitFor("!document.querySelector('.modal-shade')", "selected context policy applies");
    await click(".send-button");
    current = await saved(`board.nodes.find(node=>node.id===${js(left.id)}).messages.length===4&&!document.querySelector('.send-button.stop')`, "selected-context answer persists");
    const firstChat = report.providerCalls.filter((call) => call.kind === "chat")[0];
    assert.deepEqual(firstChat.body.messages, selectedPreview);
    assert.equal(firstChat.body.messages.filter((message) => message.content === "请仅依据所选的历史回答这次问题。").length, 1);
    assert.ok(!firstChat.body.messages.some((message) => message.content === left.messages[0].content));
    report.checks.selectedContext = { previewExactlyMatchesProviderPayload: true, noOldUnselectedQuestion: true, currentQuestionOnce: true };

    await setText('textarea[aria-label="输入消息"]', "依据采用的结论继续解释验证条件。");
    await click(".composer-context-button");
    await waitFor("Boolean(document.querySelector('.context-picker'))", "conclusion request context opens");
    await click('input[name="contextMode"][value="conclusions"]');
    await checkLabel(".context-options", title);
    const conclusionsPreview = await preview();
    assert.match(conclusionsPreview[1].content, new RegExp(agreement));
    assert.doesNotMatch(conclusionsPreview[1].content, new RegExp(`${otherConclusion}|${openQuestion}|文件路径与数据库事务的恢复机制不同`));
    await screenshot("research-smoke-context-conclusions.png");
    await clickText(".context-picker .dialog-actions", "使用此上下文");
    await waitFor("!document.querySelector('.modal-shade')", "only chosen conclusion card applies");
    await click(".send-button");
    current = await saved(`board.nodes.find(node=>node.id===${js(left.id)}).messages.length===6&&!document.querySelector('.send-button.stop')`, "conclusion-context answer persists");
    assert.deepEqual(report.providerCalls.filter((call) => call.kind === "chat")[1].body.messages, conclusionsPreview);
    report.checks.conclusionContext = { previewExactlyMatchesProviderPayload: true, onlyChosenCardAndConfirmedItems: true };

    const callsBeforeImport = report.providerCalls.length;
    await click('[aria-label="添加本地资料"]');
    current = await saved(`board.nodes.find(node=>node.id===${js(left.id)}).messages.filter(message=>message.material).length===3`, "native PDF and Markdown parts persist through actual preload IPC");
    const imported = current.nodes.find((node) => node.id === left.id).messages.filter((message) => message.material);
    assert.deepEqual(imported.map((message) => message.material), [
      { name: "local-research-reference.pdf", kind: "pdf", page: 1 },
      { name: "local-research-reference.pdf", kind: "pdf", page: 2 },
      { name: "本地研究笔记.md", kind: "markdown" },
    ]);
    assert.ok(imported.every((message) => message.role === "user"));
    assert.match(imported[0].content, /第 1 页.*\n\nLocal PDF evidence on page one\./);
    assert.match(imported[1].content, /第 2 页.*\n\nLocal PDF evidence on page two\./);
    assert.equal(report.importCalls, 1);
    assert.equal(report.providerCalls.length, callsBeforeImport);
    await evaluate("const scroll=document.querySelector('.chat-scroll');scroll.scrollTop=scroll.scrollHeight");
    await screenshot("research-smoke-materials.png");
    report.checks.materialImport = { actualPreloadIpc: true, actualLocalPdfExtraction: true, pdfPages: [1, 2], markdown: true, userMessageMetadataPersisted: true, implicitModelCalls: 0 };

    await click('[aria-label="比较分支"]');
    await waitFor("Boolean(document.querySelector('.comparison-workbench'))", "fresh comparison opens after new research");
    await click(`input[aria-label="比较分支：${right.title}"]`);
    await clickText(".comparison-actions", "生成比较");
    await waitFor("document.querySelectorAll('.comparison-item').length===3", "fresh comparison validates current sources");
    await closeModal();
    await click(`.message[data-message-id="${left.messages[1].id}"] [aria-label="编辑消息"]`);
    await setText('textarea[aria-label="修改消息内容"]', `${left.messages[1].content}\n\n补充验证：需要进行故障注入。`);
    await click(".message-editor .primary");
    await saved(`board.nodes.find(node=>node.id===${js(left.id)}).messages[1].content.includes('故障注入')`, "source edit persists after comparison");
    await click('[aria-label="比较分支"]');
    await waitFor("Boolean(document.querySelector('.comparison-results [role=alert]'))", "changed comparison source becomes stale");
    assert.match(await evaluate("document.querySelector('.comparison-results [role=alert]').textContent"), /来源会话已变化/);
    assert.equal(await evaluate("document.querySelector('.comparison-save .primary').disabled"), true);
    const conclusionCount = current.nodes.filter((node) => node.kind === "conclusion").length;
    await click(".comparison-save .primary");
    assert.equal((await api("/api/workspace")).boards[0].nodes.filter((node) => node.kind === "conclusion").length, conclusionCount);
    await screenshot("research-smoke-stale.png");
    report.checks.staleComparison = { sourceEditDetected: true, savingDisabled: true, noConclusionCreated: true };
    assert.deepEqual(report.blockedExternalRequests, []);
    assert.deepEqual(report.rendererErrors, []);
    assert.deepEqual(report.resourceErrors, []);
    assert.equal(report.providerCalls.filter((call) => call.kind === "compare").length, 2);
    assert.equal(report.providerCalls.filter((call) => call.kind === "chat").length, 2);
    assert.equal(window.isVisible(), false);
    stage = "complete";
    console.log("Hidden research smoke passed: real compare API, manual adoption, saved evidence jumps, exact selected/conclusion requests, native local PDF/Markdown import, local resume and stale guard. Artifacts: artifacts/research-smoke*.png/json");
    await finish(0);
  } catch (error) { console.error(`Hidden research smoke failed during ${stage}:`, error); await finish(1, error); }
});
