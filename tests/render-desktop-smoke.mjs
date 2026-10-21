// Run with: node node_modules/electron/cli.js tests/render-desktop-smoke.mjs
// This owns a hidden test window and an isolated temporary profile. No user window is accessed.
import { app, BrowserWindow, protocol } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLocalService } from "../server/service.mjs";
import { createBoard, createNode, newId } from "../shared/core.mjs";
import { assetFilename, isAppUrl } from "../desktop/security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "branch-render-smoke-"));
const profileDir = path.join(temporary, "profile");
const dataDir = path.join(temporary, "data");
mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
protocol.registerSchemesAsPrivileged([{ scheme: "branch-local", privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
app.on("window-all-closed", () => {});

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json; charset=utf-8",
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const report = { windowVisible: false, fontRequests: [], resourceErrors: [], rendererErrors: [], providerCalls: [], checks: {} };
let service;
let window;
let stage = "app readiness";
let finishing = false;

async function finish(code, error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  report.ok = code === 0;
  report.stage = stage;
  if (error) report.error = error.stack || String(error);
  try {
    if (window && !window.isDestroyed()) {
      try {
        const capture = await window.webContents.capturePage();
        await mkdir(path.join(root, "artifacts"), { recursive: true });
        await writeFile(path.join(root, "artifacts", "render-smoke.png"), capture.toPNG());
      } catch (captureError) { report.captureError = captureError.message; }
      window.destroy();
    }
    await service?.close();
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await writeFile(path.join(root, "artifacts", "render-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    const resolved = path.resolve(temporary);
    const expectedPrefix = path.join(path.resolve(os.tmpdir()), "branch-render-smoke-");
    if (!resolved.startsWith(expectedPrefix)) throw new Error("Refusing to remove an unexpected test profile");
    // Chromium holds profile databases open until app.exit(). A hidden Node helper
    // waits for this owned test process to exit before deleting its temporary profile.
    report.profileCleanup = "scheduled after owned Electron process exits";
    await writeFile(path.join(root, "artifacts", "render-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    const cleanup = `
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const os = require('node:os');
      const [directory, parentId] = process.argv.slice(1);
      const resolved = path.resolve(directory);
      if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()
        || !path.basename(resolved).startsWith('branch-render-smoke-')) process.exit(2);
      (async () => {
        for (let attempt = 0; attempt < 400; attempt++) {
          try { process.kill(Number(parentId), 0); }
          catch {
            await fs.rm(resolved, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        process.exitCode = 3;
      })().catch(() => { process.exitCode = 4; });
    `;
    const helper = spawn(process.execPath, ["-e", cleanup, resolved, String(process.pid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore", detached: true,
    });
    helper.on("error", (cleanupError) => console.error("Deferred profile cleanup could not start:", cleanupError.message));
    helper.unref();
  } catch (cleanupError) {
    console.error("Render smoke cleanup failed:", cleanupError);
    code = 1;
  }
  app.exit(code);
}

const deadline = setTimeout(() => {
  const error = new Error(`Hidden renderer smoke timed out during ${stage}`);
  console.error(error.message);
  void finish(1, error);
}, 45000);

async function waitFor(expression, label, timeout = 10000) {
  stage = label;
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Renderer condition was not met: ${label}`);
}

const evaluate = (source) => window.webContents.executeJavaScript(source);

app.whenReady().then(async () => {
  try {
    const dist = await realpath(path.join(root, "dist"));
    await readFile(path.join(dist, "index.html"));
    stage = "isolated workspace setup";
    const board = createBoard("完整回答的后台渲染验收");
    const node = board.nodes[0];
    node.title = "公式、排版与可调整的阅读面板";
    node.x = 100;
    node.y = 150;
    const markdown = [
      "## 一份可以直接阅读的回答", "",
      "这是 **粗体结果**，以及带下标和幂次的行内公式 $x_i^2$。", "",
      "$$\\frac{a+b}{c} = \\frac{1}{2}$$", "",
      "| 项目 | 结果 |", "| :--- | ---: |", "| 本地排版 | 通过 |", "| 数学公式 | 通过 |", "",
      "```javascript", "const result = 42;", 'console.log("readable output", result);', "```", "",
      "- 选中文字创建分支", "- 调整面板宽度后继续阅读", "",
      "> 对话保存、公式字体和代码显示都在本地完成。",
    ].join("\n");
    node.messages = [
      { id: newId(), role: "user", content: "请用公式、表格和代码解释这段结果。", createdAt: new Date().toISOString() },
      { id: newId(), role: "assistant", content: markdown, createdAt: new Date().toISOString() },
    ];
    node.summary = { title: "公式与阅读体验验收", text: "测试资料：检查真实桌面渲染中的公式、加粗、表格、代码与可调整宽度。",
      updatedAt: new Date().toISOString(), model: "render-smoke-fixture", fingerprint: "render-smoke-fixture" };
    const standard = createNode(board, { title: "保持默认尺寸的另一张卡片" });
    standard.x = 720;
    standard.y = 210;
    standard.messages = [
      { id: newId(), role: "user", content: "调整另一张卡片，会影响这张吗？", createdAt: new Date().toISOString() },
      { id: newId(), role: "assistant", content: "每张卡片独立保存宽度与高度，这张保留默认尺寸。", createdAt: new Date().toISOString() },
    ];
    standard.summary = { title: "独立尺寸保持默认", text: "测试资料：另一张卡片变大时，这张卡片仍保持 320 × 248 的默认大小。",
      updatedAt: new Date().toISOString(), model: "render-smoke-fixture", fingerprint: "render-smoke-standard" };
    service = await createLocalService({ dataDir, fetchImpl: async (url, options) => {
      report.providerCalls.push({ url, method: options.method });
      return Response.json({ choices: [{ message: { content: "This is an isolated smoke-test model stub." } }] });
    } });
    const configure = async (pathname, body) => {
      const response = await service.handle(new Request(`branch-local://app${pathname}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      assert.equal(response.status, 200, await response.clone().text());
    };
    await configure("/api/workspace", { version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
    await configure("/api/settings", { autoSummary: false, reduceMotion: true, theme: "light", showMinimap: false,
      baseUrl: "https://render-smoke.example.invalid/v1", model: "render-smoke-mock", panelWidth: 600,
      fontSize: 18, lineHeight: 1.9, codeWrap: true });
    protocol.handle("branch-local", async (request) => {
      if (!isAppUrl(request.url)) return new Response("Forbidden", { status: 403 });
      if (new URL(request.url).pathname.startsWith("/api/")) return service.handle(request);
      let filename;
      try {
        filename = await realpath(assetFilename(dist, request.url));
        const relative = path.relative(dist, filename);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Forbidden", { status: 403 });
        const bytes = await readFile(filename);
        if (/\.(woff2?|ttf)$/i.test(filename)) report.fontRequests.push({ path: new URL(request.url).pathname, bytes: bytes.length, status: 200 });
        return new Response(bytes, { headers: { "Content-Type": MIME[path.extname(filename)] || "application/octet-stream",
          "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" } });
      } catch (error) {
        report.resourceErrors.push({ url: request.url, message: error.message });
        return new Response("Test resource unavailable", { status: 404 });
      }
    });
    window = new BrowserWindow({ show: false, width: 1440, height: 1100,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    window.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === 3) report.rendererErrors.push(details.message);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (!finishing) void finish(1, new Error(`Renderer process gone: ${details.reason}`));
    });
    stage = "production renderer load";
    await window.loadURL("branch-local://app/");
    assert.equal(window.isVisible(), false);
    await waitFor("document.querySelectorAll('.node-card').length===2", "workspace cards appear");
    const initialCards = await evaluate("[...document.querySelectorAll('.node-card')].map(card=>({width:card.getBoundingClientRect().width,height:card.getBoundingClientRect().height}))");
    assert.deepEqual(initialCards, [{ width: 320, height: 248 }, { width: 320, height: 248 }]);
    const resizeKey = async (key) => {
      await evaluate(`document.querySelector('.card-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);
    };
    await resizeKey("ArrowRight");
    await resizeKey("ArrowDown");
    await waitFor("document.querySelector('.node-card').getBoundingClientRect().width===340 && document.querySelector('.node-card').getBoundingClientRect().height===268", "first card grows independently to 340 by 268");
    report.checks.cardSizes = { initial: initialCards, firstKeyboardSize: { width: 340, height: 268 } };
    await waitFor(`(async()=>{
      const workspace=await (await fetch('/api/workspace')).json();
      const nodes=workspace.boards.find(board=>board.id===${JSON.stringify(board.id)}).nodes;
      return nodes[0].width===340 && nodes[0].height===268 && nodes[1].width===320 && nodes[1].height===248;
    })()`, "first keyboard card sizes persist");
    // Keyboard resizing uses 20px increments. Visit the 220px lower height clamp
    // so the subsequent down-arrow sequence reaches exactly 420px from 248px.
    for (const key of [...Array(9).fill("ArrowRight"), ...Array(3).fill("ArrowUp"), ...Array(10).fill("ArrowDown")])
      await resizeKey(key);
    await waitFor("document.querySelector('.node-card').getBoundingClientRect().width===520 && document.querySelector('.node-card').getBoundingClientRect().height===420", "continuous keyboard resize reaches 520 by 420");
    await waitFor(`(async()=>{
      const workspace=await (await fetch('/api/workspace')).json();
      const nodes=workspace.boards.find(board=>board.id===${JSON.stringify(board.id)}).nodes;
      return nodes[0].width===520 && nodes[0].height===420 && nodes[1].width===320 && nodes[1].height===248;
    })()`, "independent card dimensions persist to workspace");
    const persistedNodes = JSON.parse(await readFile(path.join(dataDir, "workspace.json"), "utf8")).boards[0].nodes;
    assert.deepEqual(persistedNodes.map(({ width, height }) => ({ width, height })), [{ width: 520, height: 420 }, { width: 320, height: 248 }]);
    report.checks.cardSizes.persisted = persistedNodes.map(({ width, height }) => ({ width, height }));
    await evaluate("document.querySelector('.node-card').click()");
    await waitFor("Boolean(document.querySelector('.message.assistant .message-content .katex-display'))", "answer Markdown and math render");
    const rendered = await evaluate(`(() => {
      const content = document.querySelector('.message.assistant .message-content');
      const style = getComputedStyle(content);
      return {
        strong: [...content.querySelectorAll('strong')].map(item => item.textContent),
        katex: content.querySelectorAll('.katex').length,
        displayMath: content.querySelectorAll('.katex-display').length,
        fractions: content.querySelectorAll('.mfrac').length,
        table: content.querySelector('table')?.textContent,
        code: content.querySelector('pre code')?.textContent,
        codeCopyButtons: content.querySelectorAll('button[data-copy-code]').length,
        highlightedCode: Boolean(content.querySelector('.hljs-keyword')),
        codeWrap: content.classList.contains('message-code-wrap'),
        fontSize: style.fontSize, lineHeight: style.lineHeight,
        panelWidth: document.querySelector('.chat-panel').getBoundingClientRect().width,
        rawFormulaVisible: [...content.childNodes].some(item => item.nodeType === Node.TEXT_NODE && item.textContent.includes('$x_i^2$')),
      };
    })()`);
    assert.ok(rendered.strong.includes("粗体结果"));
    assert.equal(rendered.katex, 2);
    assert.equal(rendered.displayMath, 1);
    assert.ok(rendered.fractions >= 2);
    assert.match(rendered.table, /本地排版[\s\S]*数学公式/);
    assert.equal(rendered.code, 'const result = 42;\nconsole.log("readable output", result);');
    assert.equal(rendered.codeCopyButtons, 1);
    assert.equal(rendered.highlightedCode, true);
    assert.equal(rendered.codeWrap, true);
    assert.equal(rendered.fontSize, "18px");
    assert.ok(Math.abs(parseFloat(rendered.lineHeight) - 34.2) < 0.1);
    assert.ok(Math.abs(rendered.panelWidth - 600) < 2);
    assert.equal(rendered.rawFormulaVisible, false);
    report.checks.rendered = rendered;

    stage = "local KaTeX webfonts";
    const fonts = await evaluate(`(async () => {
      const loaded = await document.fonts.load('16px KaTeX_Main', 'x+y=1');
      await document.fonts.ready;
      return { loaded: loaded.length, check: document.fonts.check('16px KaTeX_Main', 'x+y=1'),
        faces: [...document.fonts].filter(face => face.family.includes('KaTeX') && face.status === 'loaded').map(face => ({family:face.family,status:face.status})) };
    })()`);
    assert.ok(fonts.loaded > 0);
    assert.equal(fonts.check, true);
    assert.ok(report.fontRequests.some((item) => /KaTeX_Main-Regular.*\.woff2$/i.test(item.path) && item.status === 200 && item.bytes > 0));
    report.checks.fonts = fonts;

    await evaluate("document.querySelector('[role=separator][aria-label=调整会话宽度]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
    await waitFor("Number(document.querySelector('[role=separator]').getAttribute('aria-valuenow'))===640 && Math.abs(document.querySelector('.chat-panel').getBoundingClientRect().width-640)<2", "keyboard width adjustment");
    report.checks.resizedWidth = await evaluate("document.querySelector('.chat-panel').getBoundingClientRect().width");
    await evaluate("document.querySelector('[title=展开阅读]').click()");
    await waitFor("Boolean(document.querySelector('.chat-panel.expanded'))", "expanded reading mode");
    const expanded = await evaluate("({panel:document.querySelector('.chat-panel').getBoundingClientRect().width,canvas:document.querySelector('.canvas-wrap').getBoundingClientRect().width,resizer:!!document.querySelector('[role=separator]')})");
    assert.ok(expanded.panel > 900);
    assert.ok(Math.abs(expanded.panel - expanded.canvas) < 2);
    assert.equal(expanded.resizer, false);
    report.checks.expanded = expanded;
    await evaluate("document.querySelector('[title=恢复面板宽度]').click()");
    await waitFor("Boolean(document.querySelector('[role=separator]')) && Math.abs(document.querySelector('.chat-panel').getBoundingClientRect().width-640)<2", "restored reading width");

    await evaluate("document.querySelector('.settings-entry').click()");
    await waitFor("Boolean(document.querySelector('.preferences-form'))", "real settings modal opens");
    await evaluate("[...document.querySelectorAll('[role=tab]')].find(item=>item.textContent==='阅读').click()");
    await waitFor("Boolean(document.querySelector('[name=fontSize]'))", "reading controls appear");
    await evaluate(`(() => {
      for (const [name,value] of [['fontSize','20'],['lineHeight','2.2']]) {
        const input=document.querySelector('[name='+name+']');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
        input.dispatchEvent(new Event('input',{bubbles:true}));
      }
    })()`);
    await evaluate("document.querySelector('.preferences-footer button[type=submit]').click()");
    await waitFor("!document.querySelector('.preferences-form') && getComputedStyle(document.querySelector('.message.assistant .message-content')).fontSize==='20px'", "saved reading settings apply to actual answer");
    const updated = await evaluate("({fontSize:getComputedStyle(document.querySelector('.message.assistant .message-content')).fontSize,lineHeight:getComputedStyle(document.querySelector('.message.assistant .message-content')).lineHeight,panel:document.querySelector('.chat-panel').getBoundingClientRect().width})");
    assert.equal(updated.fontSize, "20px");
    assert.ok(Math.abs(parseFloat(updated.lineHeight) - 44) < 0.1);
    assert.ok(Math.abs(updated.panel - 640) < 2);
    const settings = await (await service.handle(new Request("branch-local://app/api/settings"))).json();
    assert.equal(settings.panelWidth, 640);
    assert.equal(settings.fontSize, 20);
    assert.equal(settings.lineHeight, 2.2);
    assert.equal(settings.autoSummary, false);
    report.checks.updatedReading = updated;
    await evaluate("document.querySelector('.chat-scroll').scrollTop=0");
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await writeFile(path.join(root, "artifacts", "render-smoke-reading.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('[title=关闭对话面板]').click()");
    await waitFor("!document.querySelector('.chat-panel')", "close reading panel for card layout inspection");
    stage = "fit card layout using the configured shortcut hint";
    await evaluate("document.querySelector('[aria-label=\"适应画布\"]').click()");
    await waitFor("document.querySelector('.node-card').getBoundingClientRect().width===520", "fit both differently sized cards without scaling");
    const cardLayouts = await evaluate(`(() => {
      const canvas=document.querySelector('.canvas-wrap').getBoundingClientRect();
      return [...document.querySelectorAll('.node-card')].map(card=>{
        const bounds=card.getBoundingClientRect(), content=card.querySelector('.node-content').getBoundingClientRect();
        const footer=card.querySelector('.node-footer').getBoundingClientRect();
        const summary=card.querySelector('.node-summary').getBoundingClientRect(), excerpts=card.querySelector('.node-excerpts').getBoundingClientRect();
        return {width:bounds.width,height:bounds.height,
          contentWithinCard:content.left>=bounds.left && content.right<=bounds.right && content.top>=bounds.top && content.bottom<=bounds.bottom,
          footerDoesNotOverlap:content.bottom<=footer.top,
          excerptsWithinContent:excerpts.bottom<=content.bottom+0.5,
          summaryDoesNotOverlapExcerpts:summary.bottom<=excerpts.top+0.5,
          fullyVisible:bounds.left>=canvas.left && bounds.right<=canvas.right && bounds.top>=canvas.top && bounds.bottom<=canvas.bottom};
      });
    })()`);
    assert.deepEqual(cardLayouts.map(({ width, height }) => ({ width, height })), [{ width: 520, height: 420 }, { width: 320, height: 248 }]);
    for (const card of cardLayouts) {
      assert.equal(card.contentWithinCard, true);
      assert.equal(card.footerDoesNotOverlap, true);
      assert.equal(card.excerptsWithinContent, true);
      assert.equal(card.summaryDoesNotOverlapExcerpts, true);
      assert.equal(card.fullyVisible, true);
    }
    report.checks.cardSizes.layouts = cardLayouts;
    assert.equal(report.providerCalls.length, 0, "rendering a stored conversation must not send it to a real model");
    assert.deepEqual(report.resourceErrors, []);
    assert.deepEqual(report.rendererErrors, []);
    assert.equal(window.isVisible(), false);
    stage = "complete";
    console.log("Hidden desktop renderer passed: production Markdown/math/table/code + local KaTeX WOFF2 + panel resize/expand + persisted reading settings + independent card resizing/layout. Artifacts: artifacts/render-smoke.png, artifacts/render-smoke-reading.png, artifacts/render-smoke.json");
    await finish(0);
  } catch (error) {
    console.error(`Hidden renderer smoke failed during ${stage}:`, error);
    await finish(1, error);
  }
});
