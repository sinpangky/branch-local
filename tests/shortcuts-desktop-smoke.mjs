// Run with: node node_modules/electron/cli.js tests/shortcuts-desktop-smoke.mjs
// Owns a show:false window and isolated data/profile; never uses a user's window.
import { app, BrowserWindow, Menu, ipcMain, protocol } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLocalService } from "../server/service.mjs";
import { createBoard, createNode, newId } from "../shared/core.mjs";
import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, formatShortcut } from "../shared/shortcuts.mjs";
import { assetFilename, isAppUrl } from "../desktop/security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "branch-shortcuts-smoke-"));
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
const report = { windowVisible: false, rendererErrors: [], resourceErrors: [], providerCalls: [], checks: {}, screenshots: [] };
let service, window, finishing = false, stage = "app readiness";
const artifacts = path.join(root, "artifacts");
const evaluate = (source) => window.webContents.executeJavaScript(source);
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
async function sendKey(keyCode, modifiers = []) {
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await new Promise((resolve) => setTimeout(resolve, 80));
}
async function api(pathname, payload) {
  const response = await service.handle(new Request(`branch-local://app${pathname}`, payload ? {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  } : {}));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const card = (id) => `.node-card[data-node-id="${id}"]`;
async function contextMenu(id) {
  await evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(card(id))});
    const rect=element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+35,clientY:rect.top+35}));
  })()`);
  await waitFor("Boolean(document.querySelector('.context-menu [data-action=branch]'))", "node context menu opens");
}
async function dismissMenu() {
  await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await waitFor("!document.querySelector('.context-menu')", "context menu closes");
}
async function finish(code, error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  report.ok = code === 0; report.stage = stage;
  if (error) report.error = error.stack || String(error);
  try {
    if (window && !window.isDestroyed()) {
      if (error) await screenshot("shortcuts-smoke-failure.png").catch(() => {});
      assert.equal(window.isVisible(), false);
      window.destroy();
    }
    await service?.close();
    await mkdir(artifacts, { recursive: true });
    report.profileCleanup = "scheduled after the owned Electron process exits";
    await writeFile(path.join(artifacts, "shortcuts-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("branch-shortcuts-smoke-"));
    const cleanup = `
      const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
      const [directory,parent]=process.argv.slice(1),resolved=path.resolve(directory);
      if(path.dirname(resolved).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith('branch-shortcuts-smoke-'))process.exit(2);
      (async()=>{for(let i=0;i<400;i++){try{process.kill(Number(parent),0);}catch{await fs.rm(resolved,{recursive:true,force:true,maxRetries:30,retryDelay:100});return;}await new Promise(r=>setTimeout(r,50));}process.exitCode=3;})().catch(()=>{process.exitCode=4;});
    `;
    const helper = spawn(process.execPath, ["-e", cleanup, resolved, String(process.pid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore", detached: true,
    });
    helper.on("error", (failure) => console.error("Owned test profile cleanup could not start:", failure.message));
    helper.unref();
  } catch (failure) { console.error("Shortcut smoke cleanup failed:", failure); code = 1; }
  app.exit(code);
}
const deadline = setTimeout(() => void finish(1, new Error(`Shortcut renderer smoke timed out during ${stage}`)), 60000);

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
    const dist = await realpath(path.join(root, "dist"));
    await mkdir(artifacts, { recursive: true });
    const board = createBoard("快捷键与右键操作验收");
    const first = board.nodes[0]; first.title = "主干 A：菜单优先操作对象"; first.x = 70; first.y = 90;
    first.messages = [
      { id: newId(), role: "user", content: "如何让分支操作准确作用于当前选中的卡片？", createdAt: new Date().toISOString() },
      { id: newId(), role: "assistant", content: "右键菜单明确当前对象，快捷键与点击共用操作路径，并保护输入框中的编辑按键。", createdAt: new Date().toISOString() },
    ];
    const other = createNode(board, { title: "会话 B：独立保留的阅读面板" }); other.x = 510; other.y = 120;
    for (const [index, node] of board.nodes.entries()) node.summary = {
      title: index ? "会话 B：独立阅读" : "主干 A：快捷操作",
      text: index ? "测试资料：此会话保持独立，右键另一个节点后，分支应创建在该节点下。" : "测试资料：验收右键菜单、快捷键录制、绑定持久化及输入框编辑保护。",
      updatedAt: new Date().toISOString(), model: "shortcut-smoke-fixture", fingerprint: `shortcut-fixture-${index}`,
    };
    service = await createLocalService({ dataDir, fetchImpl: async (url, options) => {
      report.providerCalls.push({ url, method: options.method });
      throw new Error("Shortcut smoke refuses all provider calls");
    } });
    await api("/api/workspace", { version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
    await api("/api/settings", { autoSummary: false, reduceMotion: true, theme: "light", showMinimap: false,
      baseUrl: "https://shortcut-smoke.example.invalid/v1", model: "shortcut-smoke-fixture", shortcuts: DEFAULT_SHORTCUTS });
    protocol.handle("branch-local", async (request) => {
      if (!isAppUrl(request.url)) return new Response("Forbidden", { status: 403 });
      if (new URL(request.url).pathname.startsWith("/api/")) return service.handle(request);
      try {
        const filename = await realpath(assetFilename(dist, request.url));
        const relative = path.relative(dist, filename);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Forbidden", { status: 403 });
        return new Response(await readFile(filename), { headers: { "Content-Type": MIME[path.extname(filename)] || "application/octet-stream",
          "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" } });
      } catch (error) { report.resourceErrors.push({ url: request.url, error: error.message }); return new Response("Not found", { status: 404 }); }
    });
    ipcMain.handle("desktop:state", () => ({ maximized: false }));
    ipcMain.handle("desktop:window", () => {});
    ipcMain.on("desktop:renderer-ready", () => { report.preloadReady = true; });
    ipcMain.on("desktop:application-ready", () => { report.applicationReady = true; });
    window = new BrowserWindow({ show: false, width: 1440, height: 1000, frame: false,
      webPreferences: { preload: path.join(root, "desktop", "preload.cjs"), sandbox: true,
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === 3) report.rendererErrors.push(details.message);
    });
    await window.loadURL("branch-local://app/");
    await waitFor("document.querySelectorAll('.node-card').length===2 && Boolean(window.branchDesktop)", "real desktop renderer opens isolated workspace");
    await evaluate(`document.querySelector(${JSON.stringify(card(other.id))}).click()`);
    await waitFor("Boolean(document.querySelector('.chat-panel'))", "independent B conversation opens");
    await contextMenu(first.id);
    const defaultHint = await evaluate("document.querySelector('.context-menu [data-action=branch] kbd').textContent");
    assert.equal(defaultHint, formatShortcut(DEFAULT_SHORTCUTS.branch));
    report.checks.defaultMenu = { branch: defaultHint, actions: await evaluate("[...document.querySelectorAll('.context-menu [data-action]')].map(item=>item.dataset.action)") };
    await screenshot("shortcuts-smoke-menu-default.png");
    await dismissMenu();
    await evaluate("document.querySelector('.settings-entry').click()");
    await waitFor("Boolean(document.querySelector('.preferences-form'))", "Preferences opens");
    await evaluate("[...document.querySelectorAll('[role=tab]')].find(item=>item.textContent==='快捷键').click()");
    await waitFor(`document.querySelectorAll('[data-shortcut-action]').length===${SHORTCUT_ACTIONS.length}`, "all shortcut controls appear");
    await evaluate("document.querySelector('[data-shortcut-action=branch] .shortcut-binding').click()");
    await sendKey("Y", ["control", "shift"]);
    await waitFor(`document.querySelector('[data-shortcut-action=branch] kbd')?.textContent===${JSON.stringify(formatShortcut("Ctrl+Shift+Y"))}`, "physical Chromium keydown records Ctrl Shift Y");
    await evaluate("document.querySelector('[data-shortcut-action=branch] .shortcut-binding').click()");
    await sendKey("Escape");
    assert.equal(await evaluate("Boolean(document.querySelector('.preferences-form'))"), true);
    assert.equal(await evaluate("document.querySelector('[data-shortcut-action=branch] .shortcut-binding').getAttribute('aria-pressed')"), "false");
    assert.match(await evaluate("document.querySelector('.shortcut-settings [role=status]').textContent"), /取消录制/);
    report.checks.recordingEscape = "cancels recording while keeping Preferences open";
    await screenshot("shortcuts-smoke-settings.png");
    await evaluate("document.querySelector('.preferences-footer button[type=submit]').click()");
    await waitFor("!document.querySelector('.preferences-form')", "saved shortcut closes Preferences");
    assert.equal((await api("/api/settings")).shortcuts.branch, "Ctrl+Shift+Y");
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")).shortcuts.branch, "Ctrl+Shift+Y");
    await contextMenu(first.id);
    assert.equal(await evaluate("document.querySelector('.context-menu [data-action=branch] kbd').textContent"), formatShortcut("Ctrl+Shift+Y"));
    await screenshot("shortcuts-smoke-menu.png");
    await sendKey("B", ["control", "shift"]);
    assert.equal(await evaluate("document.querySelectorAll('.node-card').length"), 2, "the previous binding must not create a branch");
    await sendKey("Y", ["control", "shift"]);
    await waitFor("document.querySelectorAll('.node-card').length===3", "new physical shortcut creates exactly one branch");
    await waitFor(`(async()=>{const ws=await(await fetch('/api/workspace')).json();return ws.boards[0].nodes.length===3;})()`, "created branch persists");
    const merged = await api("/api/workspace");
    const branch = merged.boards[0].nodes.find((node) => ![first.id, other.id].includes(node.id));
    assert.ok(branch); assert.equal(branch.parentId, first.id);
    assert.deepEqual(branch.source.context, first.messages.map(({ role, content }) => ({ role, content })));
    report.checks.customShortcut = { binding: "Ctrl+Shift+Y", singleBranch: true, correctMenuTarget: true, inheritedMessages: branch.source.context.length, persisted: true };
    // Seed a genuine application undo record. Ctrl+Z in the composer must leave
    // this other node archived instead of invoking the canvas undo operation.
    await contextMenu(other.id);
    await evaluate("(() => { const button=document.querySelector('.context-menu [data-action=archive]'); button.focus(); button.click(); })()");
    await waitFor("Boolean(document.querySelector('.modal-actions button[type=submit]'))", "archive confirmation opens");
    await evaluate("document.querySelector('.modal-actions button[type=submit]').click()");
    await waitFor(`!document.querySelector(${JSON.stringify(card(other.id))})`, "B moves to archive");
    await evaluate(`document.querySelector(${JSON.stringify(card(branch.id))}).click()`);
    await waitFor("Boolean(document.querySelector('textarea[aria-label=输入消息]'))", "new branch composer appears");
    await evaluate(`(() => {
      const input=document.querySelector('textarea[aria-label=输入消息]');
      input.focus(); input.value='input editing safety'; input.setSelectionRange(0,0);
      window.__shortcutInputEvents=[];
      window.addEventListener('keydown',event=>{
        if(event.target===input) window.__shortcutInputEvents.push({key:event.key,ctrl:event.ctrlKey,prevented:event.defaultPrevented});
      });
    })()`);
    await sendKey("Delete");
    await sendKey("Z", ["control"]);
    const inputEvents = await evaluate("window.__shortcutInputEvents");
    assert.ok(inputEvents.some((event) => event.key === "Delete" && !event.prevented));
    assert.ok(inputEvents.some((event) => event.key.toLowerCase() === "z" && event.ctrl && !event.prevented));
    assert.equal(await evaluate("Boolean(document.querySelector('.modal-shade'))"), false);
    await waitFor(`(async()=>{const ws=await(await fetch('/api/workspace')).json();return ws.boards[0].nodes.find(n=>n.id===${JSON.stringify(other.id)}).status==='archived';})()`, "composer Ctrl Z does not undo the node archive");
    const finalWorkspace = await api("/api/workspace");
    assert.equal(finalWorkspace.boards[0].nodes.length, 3);
    assert.equal(finalWorkspace.boards[0].nodes.find((node) => node.id === branch.id).status, "active");
    report.checks.inputSafety = { events: inputEvents, archivedNodeUnchanged: true, branchNotDeleted: true };
    assert.equal(report.providerCalls.length, 0);
    assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.resourceErrors, []);
    assert.equal(window.isVisible(), false);
    stage = "complete";
    console.log("Hidden desktop shortcut smoke passed: real preload/renderer, context-menu default/custom hints, physical key recording and remapping, menu target priority, input Delete/CtrlZ safety, Esc recording cancellation. Artifacts: artifacts/shortcuts-smoke*.png/json");
    await finish(0);
  } catch (error) { console.error(`Shortcut renderer smoke failed during ${stage}:`, error); await finish(1, error); }
});
