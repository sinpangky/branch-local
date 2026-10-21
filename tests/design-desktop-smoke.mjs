// Run with Electron after building the renderer. This script never shows a window,
// accesses a user profile, contacts a real model, or drives another application.
import { app, BrowserWindow, Menu, ipcMain, protocol, safeStorage } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLocalService } from "../server/service.mjs";
import { createBoard, createNode, newId, validateWorkspace } from "../shared/core.mjs";
import { createConclusion, summaryEvidenceFingerprint, syncConclusionMessages } from "../shared/research.mjs";
import { comparisonFingerprint } from "../shared/comparison.mjs";
import { assetFilename, isAppUrl } from "../desktop/security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts", "design-1.4.1");
const temporary = mkdtempSync(path.join(os.tmpdir(), "branch-design-smoke-"));
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
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const report = { windowVisible: false, isolatedSyntheticData: true, outboundNetwork: false, viewportSizes: [],
  rendererErrors: [], resourceErrors: [], blockedExternalRequests: [], providerCalls: [], surfaces: [], issues: [], warnings: [] };
const timestamp = "2026-10-17T08:00:00.000Z";
const message = (role, content, extra = {}) => ({ id: newId(), role, content, createdAt: timestamp, ...extra });
const agreement = "文件替换和数据库事务都需要明确的提交边界，并在失败时保留上一个有效状态。";
let service, window, fixture, stage = "app readiness", finishing = false;
const js = (value) => JSON.stringify(value);
const evaluate = (source) => window.webContents.executeJavaScript(source);
const card = (id) => `.node-card[data-node-id="${id}"]`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(expression, label, timeout = 10000) {
  stage = label;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(35);
  }
  throw new Error(`Renderer condition was not met: ${label}`);
}

async function click(css) {
  await evaluate(`(() => {
    const target = [...document.querySelectorAll(${js(css)})].find(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && !element.closest('[inert]');
    });
    if (!target) throw new Error('Missing visible element: ' + ${js(css)});
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); target.click();
  })()`);
}

async function clickText(scope, text) {
  await evaluate(`(() => {
    const parent = document.querySelector(${js(scope)});
    const target = [...(parent?.querySelectorAll('button') || [])].find(element => {
      const rect = element.getBoundingClientRect();
      return element.textContent.includes(${js(text)}) && rect.width > 0 && rect.height > 0 && !element.closest('[inert]');
    });
    if (!target) throw new Error('Missing visible button: ' + ${js(scope)} + ' / ' + ${js(text)});
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); target.click();
  })()`);
}

async function clickAction(label, scope = "document") {
  const menuAction = ({ "合并其他分支": "merge", "归档当前分支": "archive" })[label];
  const attempt = () => evaluate(`(() => {
    const parent = ${scope === "document" ? "document" : `document.querySelector(${js(scope)})`};
    const target = [...(parent?.querySelectorAll('button') || [])].find(element => {
      const name = element.getAttribute('aria-label') || element.getAttribute('title') || '';
      const rect = element.getBoundingClientRect();
      return (name.startsWith(${js(label)}) || (${js(menuAction)} && element.dataset.action === ${js(menuAction)})) && rect.width > 0 && rect.height > 0 && !element.closest('[inert]');
    });
    if (!target) return false;
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); target.click(); return true;
  })()`);
  if (await attempt()) return;
  // Secondary conversation actions may be behind the redesigned More menu.
  const opened = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.chat-heading button')];
    const target = buttons.find(element => /更多|More/i.test(element.getAttribute('aria-label') || element.title || '') && element.getBoundingClientRect().width > 0);
    if (!target) return false; target.click(); return true;
  })()`);
  if (opened) { await sleep(30); if (await attempt()) return; }
  throw new Error(`Missing visible action: ${label}`);
}

async function setValue(css, value, eventName = "input") {
  await evaluate(`(() => {
    const element = document.querySelector(${js(css)});
    if (!element) throw new Error('Missing field: ' + ${js(css)});
    element.focus();
    const type = element.tagName === 'SELECT' ? HTMLSelectElement : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(element, ${js(value)});
    element.dispatchEvent(new Event(${js(eventName)}, { bubbles: true }));
  })()`);
}

async function closeModal() {
  await click('.modal-heading [aria-label="关闭弹窗"]');
  await waitFor("!document.querySelector('.modal-shade')", "modal closes");
}

async function openNode(id) {
  const selector = `.tree-row[data-node-id="${id}"] .tree-node`;
  if (await evaluate(`Boolean(document.querySelector(${js(selector)}))`)) await click(selector);
  else await click(card(id));
  await waitFor(`Boolean(document.querySelector('.chat-panel')) && document.querySelector(${js(card(id))})?.classList.contains('selected')`, "target conversation opens");
  await evaluate("document.querySelector('.chat-scroll').scrollTop = 0");
}

async function configure(pathname, payload) {
  const response = await service.handle(new Request(`branch-local://app${pathname}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function resize(width, height) {
  window.setContentSize(width, height);
  await waitFor(`Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1`, `hidden viewport becomes ${width}×${height}`);
  assert.equal(window.isVisible(), false);
  report.viewportSizes.push({ requested: { width, height }, actual: await evaluate("({width:innerWidth,height:innerHeight})") });
}

// Inspect actual laid-out content, not CSS source strings. Long code/table child
// scrollers are allowed; the dialog, reading area and whole app must contain them.
async function capture(name, { body = false } = {}) {
  stage = `capture ${name}`;
  await evaluate("document.fonts.ready");
  await sleep(80);
  const metrics = await evaluate(`(() => {
    const visible = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && style.visibility !== 'hidden' && !element.closest('[inert]'); };
    const rectOf = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right }; };
    const styleOf = element => { const style = getComputedStyle(element); return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '',
      text: (element.value || element.textContent || '').trim().slice(0, 90), fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
      lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor, rect: rectOf(element) }; };
    const surfaceRoot = document.querySelector('.modal') || document.querySelector('.context-menu') || document.querySelector('.conversation-overview') || document;
    const querySurface = selector => [...(surfaceRoot.matches?.(selector) ? [surfaceRoot] : []), ...surfaceRoot.querySelectorAll(selector)];
    const typography = [];
    for (const selector of ['.board-item button','.tree-node','.board-title','.view-label','.node-content h3','.node-summary','.chat-title','.message-content','.message-content p','.message-content pre code','.message-content th','.message-content td','.modal-heading h2','.preferences-tabs button','.preference-field','.preference-hint','.preferences-footer button','.shortcut-action-label','.overview-summary-title','.overview-summary p','.comparison-item-content','.conclusion-view-heading','.context-selection-pane','.request-preview','.global-results strong','.management-entry strong','.context-menu button','.dialog-description']) {
      const element = querySurface(selector).find(visible);
      if (element) typography.push({ selector, ...styleOf(element) });
    }
    const scrollers = querySurface('.modal,.preferences-panel,.comparison-workbench,.comparison-navigation,.comparison-reading,.context-picker,.context-selection-pane,.context-preview-pane,.conversation-overview,.chat-panel,.chat-scroll,.global-results,.management-list,.merge-choices,.request-preview').filter(visible).map(element => {
      const style = getComputedStyle(element);
      return { className: element.className, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        overflowX: style.overflowX, overflowY: style.overflowY, rect: rectOf(element) };
    });
    const textSizes = querySurface('button,label,p,small,input,textarea,select,h1,h2,h3,h4,.shortcut-action-label').filter(visible).filter(element => (element.value || element.textContent || '').trim()).map(styleOf);
    const fontDistribution = {};
    for (const sample of textSizes) { const key = sample.fontSize + '/' + sample.fontWeight + '/' + sample.lineHeight; fontDistribution[key] = (fontDistribution[key] || 0) + 1; }
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      root: { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
      dialog: document.querySelector('.modal') ? rectOf(document.querySelector('.modal')) : null,
      stickyFooter: document.querySelector('.comparison-save,.preferences-footer,.context-save-actions') ? rectOf(document.querySelector('.comparison-save,.preferences-footer,.context-save-actions')) : null,
      typography, scrollers, fontDistribution, smallText: textSizes.filter(sample => parseFloat(sample.fontSize) < 12),
      readingHeight: document.querySelector('.chat-scroll')?.getBoundingClientRect().height ?? null,
      math: document.querySelectorAll('.chat-scroll .katex').length,
      code: document.querySelectorAll('.chat-scroll .message-code').length,
      tables: document.querySelectorAll('.chat-scroll table').length };
  })()`);
  const issue = (text) => report.issues.push({ surface: name, text });
  if (metrics.root.scrollWidth > metrics.viewport.width + 2) issue(`Application overflows horizontally by ${metrics.root.scrollWidth - metrics.viewport.width}px`);
  if (metrics.dialog && (metrics.dialog.x < -1 || metrics.dialog.y < -1 || metrics.dialog.right > metrics.viewport.width + 1 || metrics.dialog.bottom > metrics.viewport.height + 1)) issue("Dialog bounds exceed the viewport");
  for (const scroller of metrics.scrollers) {
    if (scroller.scrollWidth > scroller.clientWidth + 3) issue(`${scroller.className} has ${scroller.scrollWidth - scroller.clientWidth}px of horizontal overflow`);
  }
  if (body && metrics.readingHeight < 240) issue(`Only ${metrics.readingHeight}px remains available for reading; 240px is the minimum usable message region in this test`);
  for (const sample of metrics.typography) {
    if ((sample.selector === ".message-content" || sample.selector === ".message-content p") && parseFloat(sample.fontSize) < 14) issue(`Conversation text is only ${sample.fontSize}`);
  }
  if (metrics.smallText.length) report.warnings.push({ surface: name, text: `${metrics.smallText.length} visible text elements are smaller than 12px`, samples: metrics.smallText.slice(0, 12) });
  const filename = `${String(report.surfaces.length + 1).padStart(2, "0")}-${name}.png`;
  await writeFile(path.join(artifacts, filename), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  assert.equal(window.isVisible(), false);
  report.surfaces.push({ name, screenshot: filename, ...metrics });
}

function createFixture() {
  const board = createBoard("原子保存研究 · 桌面设计验收");
  const trunk = board.nodes[0]; trunk.title = "主线：什么才算保存成功？";
  trunk.messages = [message("user", "如何比较文件保存与数据库事务的可靠性？"), message("assistant", "保存需要区分准备阶段与提交阶段；失败时仍应保留上一个有效状态。")];
  const left = createNode(board, { parentId: trunk.id, messageId: trunk.messages[1].id, quote: "准备阶段与提交阶段", title: "文件方案：原子替换与恢复" });
  const richAnswer = [
    "## 先确定提交边界", "", "**文件方案通过 rename 原子替换文件，避免先删除仍然有效的旧数据。** 这段内容为离线设计验收资料，并非实际模型回答。", "",
    "准备工作完成后才提交。假设每次失败概率为 $p$，重复尝试 $n$ 次至少成功一次的概率为：", "",
    "$$P(\\mathrm{success}) = 1 - (1-p)^n$$", "",
    "| 阶段 | 文件方案 | 数据库事务 |", "| :--- | :--- | :--- |", "| 准备 | 写入临时文件 | 写入未提交记录 |", "| 提交 | 原子替换目标 | commit 后对外可见 |", "| 失败恢复 | 保留上一份文件 | 回滚未提交修改 |", "",
    "```javascript", "async function saveWorkspace(snapshot) {", "  const pending = JSON.stringify(snapshot);", "  await writeTemporary(pending);", "  await replaceAtomically();", "  return { saved: true, revision: snapshot.revision };", "}", "```", "",
    "> 依据只说明原子替换的条件；掉电恢复、网络文件系统和并发写入仍需额外验证。", "",
    "### 下一步核对", "", "1. 验证提交前异常不会破坏旧内容。", "2. 明确多窗口冲突处理。", "3. 记录失败恢复与备份路径。", "",
    "本地资料：[保存约定](https://example.invalid/reference/saving)。这是不会被打开或请求的引用链接。",
  ].join("\n");
  left.messages = [message("user", "请用公式、表格和代码说明文件保存的条件。"), message("assistant", richAnswer, { usage: { inputTokens: 680, outputTokens: 420, cachedInputTokens: 320 } }),
    message("user", "本地资料：离线验证记录\n\n准备阶段失败时保留上一份有效文件。", { material: { name: "保存验证记录.md", kind: "markdown" } })];
  const right = createNode(board, { parentId: trunk.id, title: "事务方案：提交之后才可见" });
  right.messages = [message("user", "数据库事务如何确认保存成功？"), message("assistant", "事务需要 commit 后才对外可见；失败后可以回滚未提交的修改。需要区分事务原子性与持久性。")];
  const nested = createNode(board, { parentId: left.id, messageId: left.messages[1].id, quote: "掉电恢复、网络文件系统和并发写入仍需额外验证", title: "待验证：故障注入实验" });
  nested.messages = [message("user", "如何验证掉电后的恢复能力？"), message("assistant", "先记录提交点，再对准备、提交与清理阶段分别进行故障注入。")];
  nested.researchStatus = "verify";
  const archived = createNode(board, { title: "已归档：旧版备份策略" });
  archived.status = "archived"; archived.archivedAt = timestamp;
  archived.messages = [message("user", "保留旧版备份设计作为参考。")];
  const trashed = createNode(board, { title: "回收站：放弃的覆盖方案" });
  trashed.status = "trashed"; trashed.deletedAt = timestamp;
  trashed.messages = [message("user", "这份草稿已放弃，仍可恢复。")];
  const result = createConclusion({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] }, {
    boardId: board.id, nodeIds: [left.id, right.id], title: "已确认：明确提交边界与恢复条件", createdAt: timestamp, model: "离线固定资料",
    items: [{ id: newId(), category: "agreement", text: agreement, citations: [{ nodeId: left.id, messageId: left.messages[1].id, quote: "通过 rename 原子替换文件" }] },
      { id: newId(), category: "open", text: "持久性与异常恢复需要独立的故障注入实验。", citations: [{ nodeId: right.id, messageId: right.messages[1].id, quote: "需要区分事务原子性与持久性" }] }],
  });
  const seededBoard = result.workspace.boards[0];
  const conclusion = seededBoard.nodes.find((node) => node.id === result.nodeId);
  conclusion.conclusion.items[0].adopted = true;
  syncConclusionMessages(conclusion);
  const positions = [[trunk.id, 80, 280], [left.id, 540, 120], [right.id, 540, 480], [nested.id, 1000, 120], [conclusion.id, 1000, 480]];
  for (const [id, x, y] of positions) Object.assign(seededBoard.nodes.find((node) => node.id === id), { x, y });
  seededBoard.viewport = { x: 35, y: 25, zoom: 0.76 };
  for (const node of seededBoard.nodes) node.summary = { title: node.title.slice(0, 80), text: node.id === left.id
    ? "明确准备、提交和恢复边界，使用公式、表格与代码核对原子替换的适用条件。"
    : node.id === right.id ? "区分事务原子性与持久性，并验证 commit 之后的可见性。" : "离线验收资料：保留不同思路、上下文与可定位的依据。",
    updatedAt: timestamp, model: "离线固定资料", fingerprint: "design-smoke-fixture", evidenceFingerprint: summaryEvidenceFingerprint(seededBoard, node.id) };
  conclusion.conclusion.fingerprint = comparisonFingerprint(seededBoard, [left.id, right.id]);
  const other = createBoard("周末阅读笔记"); other.nodes[0].title = "另一张画布中的独立探索";
  other.nodes[0].messages = [message("user", "跨画布搜索能找到这段笔记吗？")];
  result.workspace.boards.push(other);
  return { workspace: validateWorkspace(result.workspace), board: seededBoard, trunk, left, right, nested, conclusion, archived, trashed };
}

async function openSettings() {
  await click(".settings-entry");
  await waitFor("Boolean(document.querySelector('.preferences-form'))", "settings opens");
}

async function settingsTabs(prefix, labels = ["模型连接", "阅读", "交互", "生成与总结", "本地数据", "快捷键"]) {
  for (const label of labels) {
    await clickText(".preferences-tabs", label);
    await waitFor(`document.querySelector('.preferences-tabs [aria-selected="true"]')?.textContent.includes(${js(label)})`, `settings tab ${label} opens`);
    await evaluate("document.querySelector('.preferences-panel').scrollTop=0");
    await capture(`${prefix}-settings-${({ 模型连接: "model", 阅读: "reading", 交互: "interaction", 生成与总结: "generation", 本地数据: "data", 快捷键: "shortcuts" })[label]}`);
  }
}

async function contextSurfaces(prefix) {
  await openNode(fixture.left.id);
  await click(".composer-context-button");
  await waitFor("Boolean(document.querySelector('.context-picker'))", "context picker opens");
  for (const mode of ["full", "selected", "conclusions"]) {
    await click(`input[name="contextMode"][value="${mode}"]`);
    if (mode === "selected") {
      const checkbox = ".context-entry-list input[type=checkbox]";
      await click(checkbox);
    } else if (mode === "conclusions") await click(".context-options input[type=checkbox]");
    if (!await evaluate("Boolean(document.querySelector('.request-preview'))")) await clickText(".context-picker", "预览实际请求内容");
    await evaluate("[...document.querySelectorAll('.request-preview details')].slice(0,2).forEach(element=>element.open=true)");
    await capture(`${prefix}-context-${mode}`);
  }
  await closeModal();
}

async function comparisonSurface(prefix, generate = true) {
  await openNode(fixture.left.id);
  await clickAction("比较分支");
  await waitFor("Boolean(document.querySelector('.comparison-workbench'))", "comparison workbench opens");
  if (!await evaluate("Boolean(document.querySelector('.comparison-results'))")) {
    await click(`input[aria-label="比较分支：${fixture.right.title}"]`);
    await capture(`${prefix}-compare-selection`);
    if (generate) {
      await clickText(".comparison-actions", "生成比较");
      await waitFor("document.querySelectorAll('.comparison-item').length===3", "offline comparison produces reviewable results");
    }
  }
  if (await evaluate("Boolean(document.querySelector('.comparison-results'))")) {
    await capture(`${prefix}-compare-results`);
    await click(".comparison-item .comparison-edit");
    await capture(`${prefix}-compare-editing`);
    await click('.comparison-edit[aria-pressed="true"]');
    await click(".comparison-item .evidence-link");
    await capture(`${prefix}-compare-evidence`);
    await evaluate("document.querySelector('.comparison-reading').scrollTop=document.querySelector('.comparison-reading').scrollHeight");
    await capture(`${prefix}-compare-bottom`);
  }
}

async function finish(code, error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  report.ok = code === 0;
  report.stage = stage;
  if (error) report.error = error.stack || String(error);
  try {
    await mkdir(artifacts, { recursive: true });
    if (window && !window.isDestroyed()) {
      if (error) await capture("failure").catch(() => {});
      assert.equal(window.isVisible(), false);
      window.destroy();
    }
    await service?.close();
    report.profileCleanup = "scheduled after owned Electron process exits";
    await writeFile(path.join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("branch-design-smoke-"));
    const cleanup = `
      const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
      const [directory,parent]=process.argv.slice(1),resolved=path.resolve(directory);
      if(path.dirname(resolved).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith('branch-design-smoke-'))process.exit(2);
      (async()=>{for(let i=0;i<400;i++){try{process.kill(Number(parent),0);}catch{await fs.rm(resolved,{recursive:true,force:true,maxRetries:30,retryDelay:100});return;}await new Promise(r=>setTimeout(r,50));}process.exitCode=3;})().catch(()=>{process.exitCode=4;});
    `;
    const helper = spawn(process.execPath, ["-e", cleanup, resolved, String(process.pid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore", detached: true,
    });
    helper.on("error", (failure) => console.error("Owned design profile cleanup could not start:", failure.message));
    helper.unref();
  } catch (failure) { console.error("Design smoke cleanup failed:", failure); code = 1; }
  app.exit(code);
}

const deadline = setTimeout(() => void finish(1, new Error(`Hidden design smoke timed out during ${stage}`)), 180000);
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
    const dist = await realpath(path.join(root, "dist"));
    await mkdir(artifacts, { recursive: true });
    fixture = createFixture();
    service = await createLocalService({ dataDir,
      secretCodec: { encrypt: (value) => safeStorage.encryptString(value).toString("base64"), decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")) },
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://design-smoke.example.invalid/v1/chat/completions");
        const body = JSON.parse(options.body);
        assert.match(body.messages[0].content, /分支比较器/);
        report.providerCalls.push({ kind: "offline-comparison", url, model: body.model, messages: body.messages.length });
        return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ title: "比较草稿：提交、恢复与验证",
          items: [{ category: "agreement", text: `### 共同条件\n\n${agreement}`, citations: [{ nodeId: fixture.left.id, messageId: fixture.left.messages[1].id, quote: "通过 rename 原子替换文件" }] },
            { category: "difference", text: "**文件路径与数据库事务的恢复机制不同。** 文件方案关注替换边界；事务方案还要核对隔离、日志与持久化条件。", citations: [{ nodeId: fixture.right.id, messageId: fixture.right.messages[1].id, quote: "事务需要 commit 后才对外可见" }] },
            { category: "open", text: "故障注入后，如何证明最后一次已确认提交仍然可恢复？\n\n- 提交前故障\n- 提交期间故障\n- 提交后重新启动", citations: [{ nodeId: fixture.left.id, messageId: fixture.left.messages[2].id, quote: "准备阶段失败时保留上一份有效文件" }] }],
        }) } }], usage: { prompt_tokens: 1200, completion_tokens: 340 } });
      },
    });
    await configure("/api/workspace", fixture.workspace);
    await configure("/api/settings", { autoSummary: false, reduceMotion: true, theme: "light", showMinimap: true,
      baseUrl: "https://design-smoke.example.invalid/v1", model: "离线验收模型", codeWrap: false, panelWidth: 640,
      systemPrompt: "本轮只使用确定的离线验收资料。" });
    for (const scheme of ["http", "https"]) protocol.handle(scheme, (request) => {
      report.blockedExternalRequests.push(request.url);
      return new Response("External requests are disabled in this isolated test", { status: 403 });
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
    const assertSender = (event) => assert.ok(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url));
    for (const [channel, result] of [["desktop:state", { maximized: false }], ["desktop:window", undefined], ["desktop:copy-text", undefined], ["desktop:open-data-directory", undefined],
      ["desktop:save-file", { saved: false }], ["desktop:open-file", null], ["desktop:choose-data-directory", null]]) {
      ipcMain.handle(channel, (event) => { assertSender(event); return result; });
    }
    ipcMain.on("desktop:renderer-ready", () => { report.preloadReady = true; });
    ipcMain.on("desktop:application-ready", () => { report.applicationReady = true; });
    window = new BrowserWindow({ show: false, width: 1600, height: 1000, frame: false,
      webPreferences: { preload: path.join(root, "desktop", "preload.cjs"), sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.on("console-message", (details) => { if (details.level === "error" || details.level === 3) report.rendererErrors.push(details.message); });
    window.webContents.on("render-process-gone", (_event, details) => { if (!finishing) void finish(1, new Error(`Renderer process gone: ${details.reason}`)); });
    await window.loadURL("branch-local://app/");
    await waitFor("document.querySelectorAll('.node-card').length===5 && Boolean(window.branchDesktop)", "isolated application and real preload open");
    await resize(1600, 1000);
    await capture("light-canvas");
    await openNode(fixture.left.id);
    await waitFor("Boolean(document.querySelector('.chat-scroll .katex-display')) && Boolean(document.querySelector('.chat-scroll table')) && Boolean(document.querySelector('.chat-scroll pre code'))", "rich reading content renders locally");
    await capture("light-reading", { body: true });
    await evaluate("document.querySelector('.chat-scroll').scrollTop=250");
    await capture("light-reading-table-code", { body: true });
    await evaluate("document.querySelector('.chat-scroll .message-code').scrollIntoView({block:'center'})");
    await capture("light-reading-code", { body: true });
    await clickAction("切换会话概览");
    await waitFor("Boolean(document.querySelector('.conversation-overview'))", "overview opens");
    await capture("light-overview");
    report.overviewSources = await evaluate("[...document.querySelectorAll('.overview-sources a')].map(element=>element.href)");
    assert.deepEqual(report.overviewSources, ["https://example.invalid/reference/saving"], "One Markdown link followed by Chinese punctuation must remain one clean source URL");
    await clickAction("切换会话概览");
    await contextSurfaces("light");
    await comparisonSurface("light");
    await closeModal();
    await openNode(fixture.conclusion.id);
    await waitFor("Boolean(document.querySelector('.conclusion-view'))", "saved conclusion opens");
    await capture("light-conclusion", { body: true });
    await click(".conclusion-view .conclusion-edit");
    await capture("light-conclusion-editing", { body: true });
    await clickText(".conclusion-editor-actions", "取消编辑");
    await click(".conclusion-view .evidence-link");
    await capture("light-conclusion-evidence", { body: true });
    await clickAction("研究进展");
    await waitFor("Boolean(document.querySelector('.research-resume'))", "research progress opens");
    await capture("light-research-progress");
    await closeModal();
    await openSettings();
    await settingsTabs("light");
    await closeModal();
    await clickAction("搜索所有画布");
    await waitFor("Boolean(document.querySelector('.global-search-field'))", "global search opens");
    await setValue('.global-search-field input', "提交");
    await waitFor("document.querySelectorAll('.global-results button').length>0", "global search finds local text");
    await capture("light-search");
    await closeModal();
    for (const label of ["归档", "回收站"]) {
      await clickText(".management-shortcuts", label);
      await waitFor("Boolean(document.querySelector('.management-entry'))", `${label} opens with stored fixture`);
      await capture(label === "归档" ? "light-archive" : "light-trash");
      await closeModal();
    }
    await openNode(fixture.left.id);
    await clickAction("合并其他分支");
    await waitFor("Boolean(document.querySelector('.merge-mode'))", "merge dialog opens");
    await click(`input[aria-label="选择会话：${fixture.right.title}"]`);
    await capture("light-merge");
    await closeModal();
    await evaluate(`(() => { const row=document.querySelector('.tree-row[data-node-id="${fixture.left.id}"]');const rect=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:rect.x+35,clientY:rect.y+15})); })()`);
    await waitFor("Boolean(document.querySelector('.context-menu'))", "native-style context menu opens");
    await capture("light-context-menu");
    await click('.context-menu [data-action="trash"]');
    await waitFor("Boolean(document.querySelector('.dialog-description'))", "destructive confirmation dialog opens");
    await capture("light-confirmation");
    await closeModal();
    await clickAction("使用指南");
    await waitFor("Boolean(document.querySelector('.help-steps'))", "help opens");
    await capture("light-help");
    await closeModal();

    await resize(980, 700);
    await openNode(fixture.left.id);
    await clickAction("展开阅读");
    await waitFor("Boolean(document.querySelector('.chat-panel.expanded'))", "narrow focused reading opens");
    await capture("narrow-light-reading", { body: true });
    await openSettings();
    await settingsTabs("narrow-light", ["模型连接", "阅读", "快捷键"]);
    await closeModal();
    await comparisonSurface("narrow-light");
    await closeModal();
    await contextSurfaces("narrow-light");

    await openSettings();
    await clickText(".preferences-tabs", "阅读");
    await setValue('select[name="theme"]', "dark", "change");
    await click('.preferences-footer button[type="submit"]');
    await waitFor("!document.querySelector('.modal-shade') && document.documentElement.dataset.theme==='dark'", "dark theme applies through saved preferences");
    await openNode(fixture.left.id);
    await capture("narrow-dark-reading", { body: true });
    await openSettings();
    await settingsTabs("narrow-dark", ["阅读", "本地数据"]);
    await closeModal();
    await resize(1600, 1000);
    await openNode(fixture.left.id);
    await capture("dark-reading", { body: true });
    await evaluate("document.querySelector('.chat-scroll .message-code').scrollIntoView({block:'center'})");
    await capture("dark-reading-code", { body: true });
    await clickAction("关闭对话面板");
    await waitFor("!document.querySelector('.chat-panel')", "reading panel closes");
    await capture("dark-canvas");
    await openSettings();
    await settingsTabs("dark", ["模型连接", "阅读", "快捷键"]);
    await closeModal();
    await comparisonSurface("dark");
    await closeModal();
    assert.deepEqual(report.blockedExternalRequests, []);
    assert.deepEqual(report.rendererErrors, []);
    assert.deepEqual(report.resourceErrors, []);
    assert.ok(report.surfaces.length >= 30, "All requested surfaces must be captured");
    assert.deepEqual(report.issues, [], "Design measurements found clipping or unreadable content; see report.json");
    stage = "complete";
    console.log(`Hidden design smoke passed: ${report.surfaces.length} surfaces, light/dark, 1600×1000 and 980×700, real preload, local fixtures; artifacts/design-1.4.1/report.json`);
    await finish(0);
  } catch (error) { console.error(`Hidden design smoke failed during ${stage}:`, error); await finish(1, error); }
});
