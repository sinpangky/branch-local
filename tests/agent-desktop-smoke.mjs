// Owned hidden Electron window, real preload/service/tools, synthetic models and temp files only.
import { app, BrowserWindow, Menu, ipcMain, protocol } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createLocalService } from "../server/service.mjs";
import { createBoard, createNode, newId } from "../shared/core.mjs";
import { AGENT_CAPABILITIES, AGENT_WORKFLOWS, AGENT_EXECUTION_RULES } from "../shared/agent-guide.mjs";
import { assetFilename, isAppUrl } from "../desktop/security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "branch-agent-smoke-"));
const profileDir = path.join(temporary, "profile"), dataDir = path.join(temporary, "data"), workingDir = path.join(temporary, "work");
mkdirSync(profileDir, { recursive: true }); mkdirSync(workingDir);
app.setPath("userData", profileDir);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "branch-local", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.on("window-all-closed", () => {});
const artifacts = path.join(root, "artifacts");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const report = { windowVisible: false, isolatedSyntheticData: true, realModelRequests: 0, rendererErrors: [], resourceErrors: [], blockedExternalRequests: [], requests: [], providerCalls: [], checks: {}, screenshots: [] };
const scenarioSteps = new Map();
const completedText = "已创建 **result.txt**，并通过 PowerShell 验证文件内容。";
const fileToolsText = "已逐次批准创建 reports、写入并局部编辑 reports/tool-check.txt；按行重读确认 status=verified，其他行保持不变。";
let service, window, finishing = false, stage = "app readiness", directoryChoices = 0, directoryOpens = 0;
const evaluate = (source) => window.webContents.executeJavaScript(source);
const js = JSON.stringify;
const card = (id) => `.node-card[data-node-id="${id}"]`;
async function waitFor(expression, label, timeout = 15000) {
  stage = label; const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 35)); }
  throw new Error(`Renderer condition was not met: ${label}`);
}
async function hostWait(predicate, label, timeout = 12000) {
  stage = label; const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 35)); }
  throw new Error(`Host condition was not met: ${label}`);
}
async function click(css) {
  await evaluate(`(()=>{const target=document.querySelector(${js(css)});if(!target)throw new Error('Missing element '+${js(css)});if(target.disabled)throw new Error('Disabled element '+${js(css)});target.focus();target.click();})()`);
}
async function clickText(scope, text) {
  if (scope === ".agent-approval") await waitFor(`(()=>{const target=[...document.querySelectorAll('.agent-approval button')].find(button=>button.textContent.includes(${js(text)}));if(!target)return false;const rect=target.getBoundingClientRect(),viewport=target.closest('.chat-scroll')?.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return viewport&&rect.top>=viewport.top-1&&rect.bottom<=viewport.bottom+1&&rect.left>=0&&rect.right<=innerWidth&&target.contains(hit);})()`, "approval action is visibly reachable without test scrolling or overlay obstruction", 6000);
  await evaluate(`(()=>{const parent=document.querySelector(${js(scope)});const target=[...parent.querySelectorAll('button')].find(button=>button.textContent.includes(${js(text)}));if(!target)throw new Error('Missing button '+${js(text)});if(target.disabled)throw new Error('Disabled button');target.focus();if(document.activeElement!==target)throw new Error('Button could not receive DOM focus');target.click();})()`);
}
async function setText(css, value) {
  await evaluate(`(()=>{const input=document.querySelector(${js(css)});if(!input)throw new Error('Missing input');input.focus();const type=input.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(input,${js(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function selectMode(mode) {
  await evaluate(`(()=>{const input=document.querySelector('select[aria-label="执行方式"]');if(!input||input.disabled)throw new Error('Execution selector unavailable');input.focus();input.value=${js(mode)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('select[aria-label="执行方式"]').value===${js(mode)}`, "execution mode selected");
}
async function api(pathname, payload) {
  const response = await service.handle(new Request(`branch-local://app${pathname}`, payload ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}));
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
async function saved(expression, label) {
  await waitFor(`(async()=>{const workspace=await(await fetch('/api/workspace')).json();const board=workspace.boards[0];return ${expression};})()`, label);
  return (await api("/api/workspace")).boards[0];
}
async function openNode(id) {
  await click(card(id));
  await waitFor(`Boolean(document.querySelector('.chat-panel'))&&document.querySelector(${js(card(id))})?.classList.contains('selected')`, "target conversation opens");
}
async function send(prompt) { await setText('textarea[aria-label="输入消息"]', prompt); await click('.send-button:not(.stop)'); }
async function screenshot(filename) {
  await evaluate("document.fonts.ready"); await new Promise((resolve) => setTimeout(resolve, 60));
  await writeFile(path.join(artifacts, filename), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); report.screenshots.push(filename);
}
async function closeModal() { await click('.modal-heading [aria-label="关闭弹窗"]'); await waitFor("!document.querySelector('.modal-shade')", "modal closes"); }
async function missing(file) { try { await access(file); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } }
function completion(content = "", name = "", args = {}, id = "") {
  return Response.json({ choices: [{ message: { role: "assistant", content, ...(name ? { tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : {}) } }], usage: { prompt_tokens: 90, completion_tokens: 20 } });
}
async function finish(code, error) {
  if (finishing) return; finishing = true; clearTimeout(deadline);
  report.ok = code === 0; report.stage = stage; if (error) report.error = error.stack || String(error);
  try {
    if (window && !window.isDestroyed()) { if (error) await screenshot("agent-smoke-failure.png").catch(() => {}); assert.equal(window.isVisible(), false); window.destroy(); }
    await service?.close(); await mkdir(artifacts, { recursive: true });
    report.profileCleanup = "scheduled after the owned Electron process exits";
    await writeFile(path.join(artifacts, "agent-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith("branch-agent-smoke-"));
    const cleanup = `const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');const [directory,parent]=process.argv.slice(1),resolved=path.resolve(directory);if(path.dirname(resolved).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith('branch-agent-smoke-'))process.exit(2);(async()=>{for(let i=0;i<400;i++){try{process.kill(Number(parent),0);}catch{await fs.rm(resolved,{recursive:true,force:true,maxRetries:30,retryDelay:100});return;}await new Promise(r=>setTimeout(r,50));}process.exitCode=3;})().catch(()=>{process.exitCode=4;});`;
    const helper = spawn(process.execPath, ["-e", cleanup, resolved, String(process.pid)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore", detached: true });
    helper.on("error", (failure) => console.error("Owned test cleanup could not start:", failure.message)); helper.unref();
  } catch (failure) { console.error("Agent smoke cleanup failed:", failure); code = 1; }
  app.exit(code);
}
const deadline = setTimeout(() => void finish(1, new Error(`Hidden Agent smoke timed out during ${stage}`)), 110000);

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null); const dist = await realpath(path.join(root, "dist")); await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(workingDir, "source.txt"), "Synthetic source fixture\n");
    const board = createBoard("可选 Agent · 隐藏桌面验收"), trunk = board.nodes[0]; trunk.title = "直接聊天与 Agent";
    const sibling = createNode(board, { title: "另一会话（检查结果归属）" });
    service = await createLocalService({ dataDir, allowAgent: true, fetchImpl: async (url, options) => {
      assert.equal(url, "https://agent-smoke.example.invalid/v1/chat/completions");
      const body = JSON.parse(options.body);
      const scenario = [...body.messages].reverse().find((message) => message.role === "user")?.content.match(/SMOKE_[A-Z]+/)?.[0] || "UNKNOWN";
      report.providerCalls.push({ scenario, agent: Boolean(body.tools), roles: body.messages.map((message) => message.role), hasToolChoice: Object.hasOwn(body, "tool_choice") });
      if (!body.tools) { assert.equal(Object.hasOwn(body, "tool_choice"), false); return completion("普通聊天回答：**保持原有能力**。"); }
      const step = scenarioSteps.get(scenario) || 0; scenarioSteps.set(scenario, step + 1);
      const call = (name, args) => completion("", name, args, `${scenario}_${step}`);
      if (scenario === "SMOKE_COMPLETE") {
        if (step === 0) return call("read_file", { path: "source.txt" });
        if (step === 1) { assert.match(body.messages.at(-1).content, /Synthetic source fixture/); return call("write_file", { path: "result.txt", content: "Agent verified\n" }); }
        if (step === 2) return call("run_command", { command: "if ((Get-Content -LiteralPath 'result.txt' -Raw).Trim() -ne 'Agent verified') { throw 'wrong content' }; Write-Output 'VERIFIED_AGENT_FIXTURE'", timeout_ms: 10000 });
        assert.match(body.messages.at(-1).content, /VERIFIED_AGENT_FIXTURE/); return completion(completedText);
      }
      if (scenario === "SMOKE_FILETOOLS") {
        if (step === 0) return call("create_directory", { path: "reports" });
        const result = JSON.parse(body.messages.at(-1).content);
        if (step === 1) { assert.equal(result.created, true); return call("write_file", { path: "reports/tool-check.txt", content: "status=pending\ncount=1\n" }); }
        if (step === 2) { assert.equal(result.written, true); return call("edit_file", { path: "reports/tool-check.txt", old_text: "status=pending", new_text: "status=verified" }); }
        if (step === 3) { assert.equal(result.replacements, 1); return call("read_file", { path: "reports/tool-check.txt", start_line: 1, end_line: 2 }); }
        assert.equal(result.content, "status=verified\ncount=1\n"); assert.equal(result.content_truncated, false);
        return completion(fileToolsText);
      }
      if (scenario === "SMOKE_DENIED") {
        if (step === 0) return call("write_file", { path: "denied.txt", content: "must never exist" });
        assert.match(body.messages.at(-1).content, /拒绝/); return completion("已尊重拒绝，未写入文件。");
      }
      if (scenario === "SMOKE_PENDING") return call("write_file", { path: "pending.txt", content: "must never exist" });
      if (scenario === "SMOKE_COMMAND") {
        if (step === 0) return call("run_command", { command: "$PID | Set-Content -LiteralPath 'command-pid.txt'; Start-Sleep -Seconds 20; 'LEAK' | Set-Content -LiteralPath 'command-leak.txt'", timeout_ms: 30000 });
        return completion("命令已结束。");
      }
      if (scenario === "SMOKE_NARROW") {
        if (step === 0) return call("write_file", { path: "result.txt", content: "Narrow-screen proposed content\nsecond line\nthird line\n" });
        assert.match(body.messages.at(-1).content, /拒绝/); return completion("窄窗口审批已拒绝，原文件保持不变。");
      }
      if (scenario === "SMOKE_BRANCH") {
        assert.equal(body.messages.some((message) => message.role === "tool"), false, "new branch must not inherit executable tool messages");
        assert.equal(JSON.stringify(body.messages).includes('"agentRun"'), false);
        assert.ok(body.messages.some((message) => message.content === completedText));
        return completion("分支使用文字上下文；所有分支仍共享同一工作目录。");
      }
      throw new Error(`Unexpected synthetic model scenario ${scenario} step ${step}`);
    } });
    await api("/api/workspace", { version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
    await api("/api/settings", { autoSummary: false, reduceMotion: true, theme: "light", showMinimap: false, baseUrl: "https://agent-smoke.example.invalid/v1", model: "agent-smoke-model", agentEnabled: true, agentWorkspace: workingDir, agentAllowCommands: true, agentAllowNetwork: false, agentEngine: "compatible", agentMaxSteps: 12 });
    for (const scheme of ["http", "https"]) protocol.handle(scheme, (request) => { report.blockedExternalRequests.push(request.url); return new Response("External requests disabled", { status: 403 }); });
    protocol.handle("branch-local", async (request) => {
      if (!isAppUrl(request.url)) return new Response("Forbidden", { status: 403 }); const pathname = new URL(request.url).pathname;
      if (pathname.startsWith("/api/")) { if (pathname.startsWith("/api/agent/") || pathname === "/api/chat") report.requests.push({ path: pathname, method: request.method }); return service.handle(request); }
      try { const filename = await realpath(assetFilename(dist, request.url)), relative = path.relative(dist, filename); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Forbidden", { status: 403 }); return new Response(await readFile(filename), { headers: { "Content-Type": MIME[path.extname(filename)] || "application/octet-stream", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" } }); }
      catch (error) { report.resourceErrors.push({ url: request.url, error: error.message }); return new Response("Not found", { status: 404 }); }
    });
    const assertSender = (event) => assert.ok(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url));
    ipcMain.handle("desktop:state", () => ({ maximized: false })); ipcMain.handle("desktop:window", () => {});
    ipcMain.handle("desktop:choose-agent-directory", (event) => { assertSender(event); directoryChoices += 1; return { canceled: false, directory: workingDir }; });
    ipcMain.handle("desktop:open-agent-directory", (event) => { assertSender(event); directoryOpens += 1; return { opened: true }; });
    ipcMain.handle("desktop:copy-text", (event) => { assertSender(event); return { copied: true }; });
    ipcMain.on("desktop:renderer-ready", () => { report.preloadReady = true; }); ipcMain.on("desktop:application-ready", () => { report.applicationReady = true; });
    window = new BrowserWindow({ show: false, width: 1600, height: 1100, frame: false, webPreferences: { preload: path.join(root, "desktop", "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.on("console-message", (details) => { if (details.level === "error" || details.level === 3) report.rendererErrors.push(details.message); });
    await window.loadURL("branch-local://app/");
    await waitFor("document.querySelectorAll('.node-card').length===2&&Boolean(window.branchDesktop?.chooseAgentDirectory)", "isolated app and actual sandbox preload open");
    report.version = await evaluate("window.branchDesktop.version");
    await openNode(trunk.id);
    assert.equal(await evaluate("document.querySelector('select[aria-label=\"执行方式\"]').value"), "chat");
    await send("SMOKE_CHAT：按普通方式回答即可。");
    await saved(`board.nodes.find(node=>node.id===${js(trunk.id)}).messages.some(message=>message.content.includes('普通聊天回答'))`, "direct chat persists without Agent");
    await waitFor("!document.querySelector('.send-button.stop')", "direct chat completes");
    assert.equal((await api("/api/workspace")).boards[0].nodes[0].messages.some((message) => message.agentRun), false);
    report.checks.directChat = { originalEndpoint: report.requests.some((request) => request.path === "/api/chat"), noTools: !report.providerCalls[0].agent, noExecutionMetadata: true };

    await selectMode("agent");
    assert.match(await evaluate("document.querySelector('.agent-composer-note').textContent"), /分支共享工作目录/);
    await clickText(".agent-composer-note", "设置 Agent");
    await waitFor("Boolean(document.querySelector('input[name=agentWorkspace]'))", "Agent settings opens directly");
    await clickText(".preferences-form", "选择 Agent 工作目录");
    await waitFor("document.querySelector('input[name=agentWorkspace]').value.length>0", "native directory selection reflected");
    await clickText(".preferences-form", "打开 Agent 工作目录");
    assert.equal(directoryChoices, 1); assert.equal(directoryOpens, 1);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Agent 能力指南\"]').open"), false);
    await screenshot("agent-smoke-settings-light.png");
    await click('.preference-agent-guide > summary');
    await waitFor("document.querySelector('.preference-agent-guide').open", "Agent capability guide expands in actual renderer");
    const guide = await evaluate("(()=>{const guide=document.querySelector('.preference-agent-guide');return {workflows:[...guide.querySelectorAll('[data-agent-workflow]')].map(entry=>entry.dataset.agentWorkflow),capabilities:[...guide.querySelectorAll('[data-agent-capability]')].map(entry=>entry.dataset.agentCapability),toolsOpen:guide.querySelector('.preference-agent-tool-guide').open,rulesOpen:guide.querySelector('.preference-agent-rules').open};})()");
    assert.deepEqual(guide.workflows, AGENT_WORKFLOWS.map((entry) => entry.id)); assert.equal(guide.workflows.length, 8);
    assert.deepEqual(guide.capabilities, AGENT_CAPABILITIES.map((entry) => entry.id)); assert.equal(guide.capabilities.length, 10);
    assert.equal(guide.toolsOpen, false); assert.equal(guide.rulesOpen, false);
    await evaluate("document.querySelector('.preference-agent-guide').scrollIntoView({block:'start'})");
    await screenshot("agent-smoke-guide-light.png");
    await click('.preference-agent-tool-guide > summary');
    await click('.preference-agent-rules > summary');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"内置 Agent 执行规则\"]').textContent"), AGENT_EXECUTION_RULES);
    await evaluate("document.querySelector('.preference-agent-rules').scrollIntoView({block:'start'})");
    await screenshot("agent-smoke-rules-light.png");
    await closeModal();
    report.checks.settings = { nativeDirectoryPicker: true, nativeOpenDirectory: true, sharedDirectoryDisclosure: true, guideCollapsedByDefault: true, workflowCount: 8, toolCount: 10, rulesMatchRuntimeSource: true };

    await send("SMOKE_COMPLETE：读取 source.txt，创建 result.txt 并运行验证。");
    await waitFor("Boolean(document.querySelector('.agent-approval [aria-label=\"写入后的完整内容\"]'))", "write approval shows exact content");
    assert.equal(await missing(path.join(workingDir, "result.txt")), true);
    assert.match(await evaluate("document.querySelector('.agent-approval').textContent"), /Agent verified/);
    await screenshot("agent-smoke-write-approval.png");
    await clickText(".agent-approval", "允许此次操作");
    await waitFor("Boolean(document.querySelector('.agent-command-preview'))", "command approval follows approved write");
    assert.equal(await readFile(path.join(workingDir, "result.txt"), "utf8"), "Agent verified\n");
    assert.match(await evaluate("document.querySelector('.agent-command-warning').textContent"), /当前系统用户权限|当前用户权限/);
    await screenshot("agent-smoke-command-approval.png"); await clickText(".agent-approval", "允许此次操作");
    let current = await saved(`board.nodes.find(node=>node.id===${js(trunk.id)}).messages.some(message=>message.agentRun?.status==='completed'&&message.content===${js(completedText)})`, "Agent final content and trace persist");
    await waitFor("!document.querySelector('.send-button.stop')", "completed run releases composer");
    const successful = current.nodes.find((node) => node.id === trunk.id).messages.find((message) => message.content === completedText);
    assert.deepEqual(successful.agentRun.events.filter((event) => event.tool !== "workspace").map((event) => [event.tool, event.status]), [["read_file", "completed"], ["write_file", "completed"], ["run_command", "completed"]]);
    assert.equal(successful.agentRun.artifacts[0].path, "result.txt");
    await click(`.message[data-message-id="${successful.id}"] .agent-trace-heading`);
    await waitFor("Boolean(document.querySelector('.agent-artifacts'))", "completed trace expands");
    await clickText(".agent-artifacts", "打开工作目录"); assert.equal(directoryOpens, 2);
    report.checks.completed = { writeBlockedUntilApproval: true, exactContentWritten: true, realPowerShellValidation: true, persistedTools: successful.agentRun.events.length, persistedArtifact: true, resultNode: trunk.id };
    await screenshot("agent-smoke-completed-light.png");

    await click(`.message[data-message-id="${successful.id}"] .branch-action`);
    current = await saved("board.nodes.length===3", "branch from Agent answer saves");
    const branch = current.nodes.find((node) => node.parentId === trunk.id);
    assert.ok(branch); assert.ok(branch.source.context.some((message) => message.content === completedText));
    assert.ok(branch.source.context.every((message) => Object.keys(message).every((key) => ["role", "content"].includes(key))));
    await waitFor(`document.querySelector(${js(card(branch.id))})?.classList.contains('selected')`, "new branch selected");
    await selectMode("agent"); assert.match(await evaluate("document.querySelector('.agent-composer-note').textContent"), /分支共享工作目录/);
    await send("SMOKE_BRANCH：说明本分支继承的上下文。");
    current = await saved(`board.nodes.find(node=>node.id===${js(branch.id)}).messages.some(message=>message.agentRun?.status==='completed')`, "branch run persists to branch only");
    await waitFor("!document.querySelector('.send-button.stop')", "branch run releases composer");
    assert.equal(current.nodes.find((node) => node.id === trunk.id).messages.length, 4);
    assert.equal(current.nodes.find((node) => node.id === sibling.id).messages.length, 0);
    report.checks.branch = { inheritedTextOnly: true, noToolCallsReplayed: true, sharedWorkingDirectoryWarning: true, resultSavedToCorrectBranch: true };

    await send("SMOKE_FILETOOLS：逐次确认创建目录、写文件和局部编辑，然后按行重读核对。");
    await waitFor("Boolean(document.querySelector('.agent-approval'))&&document.querySelector('.agent-approval').textContent.includes('创建单层目录')", "directory creation waits for approval");
    assert.equal(await missing(path.join(workingDir, "reports")), true);
    assert.equal(await evaluate("document.querySelector('.agent-approval .agent-preview-meta code').textContent"), "reports");
    await screenshot("agent-smoke-directory-approval.png");
    await clickText(".agent-approval", "允许此次操作");
    await waitFor("Boolean(document.querySelector('.agent-approval .agent-file-preview.is-new'))", "file creation waits for separate approval");
    assert.equal(await missing(path.join(workingDir, "reports")), false);
    assert.equal(await missing(path.join(workingDir, "reports/tool-check.txt")), true);
    await clickText(".agent-approval", "允许此次操作");
    await waitFor("Boolean(document.querySelector('.agent-approval'))&&document.querySelector('.agent-approval').textContent.includes('局部替换（1 处）')", "precise edit shows replacement count before approval");
    assert.equal(await readFile(path.join(workingDir, "reports/tool-check.txt"), "utf8"), "status=pending\ncount=1\n");
    assert.equal(await evaluate("document.querySelector('.agent-approval [aria-label=\"修改前的完整内容\"] pre').textContent"), "status=pending\ncount=1\n");
    assert.equal(await evaluate("document.querySelector('.agent-approval [aria-label=\"写入后的完整内容\"] pre').textContent"), "status=verified\ncount=1\n");
    await screenshot("agent-smoke-edit-approval.png");
    await clickText(".agent-approval", "允许此次操作");
    current = await saved(`board.nodes.find(node=>node.id===${js(branch.id)}).messages.some(message=>message.agentRun?.status==='completed'&&message.content===${js(fileToolsText)})`, "new file tools persist real completion record");
    await waitFor("!document.querySelector('.send-button.stop')", "new file tools release composer");
    assert.equal(await readFile(path.join(workingDir, "reports/tool-check.txt"), "utf8"), "status=verified\ncount=1\n");
    const fileToolRun = current.nodes.find((node) => node.id === branch.id).messages.find((message) => message.content === fileToolsText).agentRun;
    assert.deepEqual(fileToolRun.events.filter((event) => event.tool !== "workspace").map((event) => [event.tool, event.status]), [["create_directory", "completed"], ["write_file", "completed"], ["edit_file", "completed"], ["read_file", "completed"]]);
    report.checks.fileTools = { directoryBlockedUntilApproval: true, fileCreationSeparatelyApproved: true, exactEditSeparatelyApproved: true, unchangedLinesPreserved: true, lineReadVerifiedBySyntheticModel: true, persistedTools: 4 };

    await send("SMOKE_DENIED：提出一次需要我拒绝的写入。");
    await waitFor("Boolean(document.querySelector('.agent-approval'))", "denied write awaits approval");
    await clickText(".agent-approval", "拒绝");
    current = await saved(`board.nodes.find(node=>node.id===${js(branch.id)}).messages.some(message=>message.content.includes('已尊重拒绝')&&message.agentRun?.status==='completed')`, "denial trace persists");
    assert.equal(await missing(path.join(workingDir, "denied.txt")), true);
    await waitFor("!document.querySelector('.send-button.stop')", "denied run releases composer");
    assert.ok(current.nodes.find((node) => node.id === branch.id).messages.some((message) => message.agentRun?.events.some((event) => event.tool === "write_file" && event.status === "denied")));
    report.checks.denial = { noWrite: true, decisionSentToModel: true, durableDeniedStatus: true };

    await send("SMOKE_PENDING：等待审批时测试停止。");
    await waitFor("Boolean(document.querySelector('.agent-approval'))", "cancellation fixture awaits approval");
    await openNode(sibling.id);
    assert.match(await evaluate("document.querySelector('.agent-running-link').textContent"), /等待确认/);
    await click(".agent-running-link");
    await waitFor(`document.querySelector(${js(card(branch.id))})?.classList.contains('selected')&&Boolean(document.querySelector('.agent-approval'))`, "returns to pending operation in originating branch");
    await click('.send-button.stop');
    await waitFor("!document.querySelector('.send-button.stop')&&!document.querySelector('.agent-approval')", "stopping pending approval clears runtime");
    await hostWait(async () => (await api("/api/agent/capabilities")).activeRunIds.length === 0, "pending runtime removed");
    assert.equal(await missing(path.join(workingDir, "pending.txt")), true);
    report.checks.stopPending = { crossConversationReturn: true, noWrite: true, pendingApprovalRemoved: true, runtimeRemoved: true };

    await send("SMOKE_COMMAND：运行长命令后测试停止。");
    await waitFor("Boolean(document.querySelector('.agent-command-preview'))", "long command awaits approval"); await clickText(".agent-approval", "允许此次操作");
    await hostWait(async () => !await missing(path.join(workingDir, "command-pid.txt")), "real command begins before cancellation");
    const commandPid = Number((await readFile(path.join(workingDir, "command-pid.txt"), "utf8")).replace(/^\uFEFF/, "").trim());
    assert.ok(Number.isInteger(commandPid) && commandPid > 0);
    await click('.send-button.stop'); await waitFor("!document.querySelector('.send-button.stop')", "running command cancellation completes");
    await hostWait(async () => { try { process.kill(commandPid, 0); return false; } catch { return true; } }, "owned PowerShell process terminated");
    await hostWait(async () => (await api("/api/agent/capabilities")).activeRunIds.length === 0, "command runtime removed");
    assert.equal(await missing(path.join(workingDir, "command-leak.txt")), true);
    current = await saved(`board.nodes.find(node=>node.id===${js(branch.id)}).messages.filter(message=>message.agentRun?.status==='cancelled').length===2`, "both cancellation records persist");
    report.checks.stopRunning = { realProcessStarted: true, processTerminated: true, noLateFile: true, durableCancelledRun: true };

    const persisted = JSON.parse(await readFile(path.join(dataDir, "workspace.json"), "utf8"));
    assert.ok(persisted.boards[0].nodes.find((node) => node.id === trunk.id).messages.find((message) => message.id === successful.id).agentRun.artifacts.length);
    await window.reload();
    await waitFor("document.querySelectorAll('.node-card').length===3", "reload restores saved conversation tree"); await openNode(trunk.id);
    await waitFor(`document.querySelector('.message[data-message-id="${successful.id}"] .agent-trace')?.dataset.runStatus==='completed'`, "reload retains completed trace");
    report.checks.reload = { realDiskPersistence: true, completedMetadataRetained: true };
    await selectMode("chat"); await send("SMOKE_CHAT：Agent 后继续普通聊天。");
    await saved(`board.nodes.find(node=>node.id===${js(trunk.id)}).messages.filter(message=>message.content.includes('普通聊天回答')).length===2`, "direct chat remains usable after Agent");
    await waitFor("!document.querySelector('.send-button.stop')", "last direct answer completes");
    const allCalls = report.providerCalls.filter((call) => !call.agent); assert.equal(allCalls.length, 2); assert.ok(allCalls.every((call) => !call.hasToolChoice));

    report.readability = await evaluate(`(()=>{const trace=document.querySelector('.agent-trace'),header=trace.querySelector('.agent-trace-heading'),style=getComputedStyle(trace),rect=trace.getBoundingClientRect();return {fontSize:style.fontSize,lineHeight:style.lineHeight,fontFamily:style.fontFamily,headerWeight:getComputedStyle(header.querySelector('strong')).fontWeight,traceWithinChat:rect.left>=document.querySelector('.chat-panel').getBoundingClientRect().left&&rect.right<=innerWidth,viewportHorizontalOverflow:document.documentElement.scrollWidth>innerWidth,window:{width:innerWidth,height:innerHeight}};})()`);
    assert.equal(report.readability.fontSize, "14px"); assert.equal(report.readability.viewportHorizontalOverflow, false); assert.equal(report.readability.traceWithinChat, true);
    await screenshot("agent-smoke-final-light.png");
    await click(".settings-entry");
    await waitFor("Boolean(document.querySelector('.preferences-form'))", "settings available after Agent runs");
    await clickText(".preferences-tabs", "阅读");
    await evaluate("(()=>{const select=document.querySelector('select[name=theme]');select.value='dark';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await clickText(".preferences-footer", "保存设置");
    await waitFor("!document.querySelector('.modal-shade')&&document.documentElement.dataset.theme==='dark'", "dark theme applied through settings");
    await selectMode("agent");
    await screenshot("agent-smoke-completed-dark.png");
    window.setSize(980, 700, false);
    await waitFor("innerWidth<1000&&innerHeight<730", "narrow hidden viewport applies");
    await send("SMOKE_NARROW：核对窄窗口的修改预览。");
    await waitFor("Boolean(document.querySelector('.agent-file-preview.is-existing'))", "narrow approval compares old and new file contents");
    // Verify both actions fit and hit-test in the scroll viewport without a test-induced scroll.
    await waitFor("(()=>{const buttons=[...document.querySelectorAll('.agent-approval button')];return buttons.length===2&&buttons.every(target=>{const r=target.getBoundingClientRect(),v=target.closest('.chat-scroll').getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.top>=v.top-1&&r.bottom<=v.bottom+1&&target.contains(hit);});})()", "narrow approval actions visible and unobstructed", 6000);
    report.narrowReadability = await evaluate("(()=>{const trace=document.querySelector('.agent-trace[data-run-status=running]'),rect=trace.getBoundingClientRect();return {width:innerWidth,height:innerHeight,viewportHorizontalOverflow:document.documentElement.scrollWidth>innerWidth,traceWithinViewport:rect.left>=0&&rect.right<=innerWidth,previewColumns:getComputedStyle(document.querySelector('.agent-file-preview')).gridTemplateColumns,approvalButtonVisible:true};})()");
    assert.equal(report.narrowReadability.viewportHorizontalOverflow, false); assert.equal(report.narrowReadability.traceWithinViewport, true);
    await screenshot("agent-smoke-approval-dark-narrow.png");
    await clickText(".agent-approval", "拒绝");
    await waitFor("!document.querySelector('.send-button.stop')", "narrow approval denial finishes");
    assert.equal(await readFile(path.join(workingDir, "result.txt"), "utf8"), "Agent verified\n");
    await clickText(".agent-composer-note", "设置 Agent");
    await waitFor("Boolean(document.querySelector('input[name=agentWorkspace]'))", "narrow Agent settings open");
    assert.equal(await evaluate("document.querySelector('.preference-agent-guide').open"), false);
    await click('.preference-agent-guide > summary');
    await click('.preference-agent-tool-guide > summary');
    await click('.preference-agent-rules > summary');
    await evaluate("document.querySelector('.preference-agent-rules').scrollIntoView({block:'start'})");
    const dialogBounds = await evaluate("(()=>{const r=document.querySelector('.modal').getBoundingClientRect(),footer=document.querySelector('.preferences-footer').getBoundingClientRect(),button=document.querySelector('.preferences-footer button[type=submit]'),b=button.getBoundingClientRect(),panel=document.querySelector('.preferences-panel'),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,footerVisible:footer.bottom<=innerHeight,saveReachable:b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth&&button.contains(hit),viewportOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:panel.scrollWidth>panel.clientWidth+1,guideOpen:document.querySelector('.preference-agent-guide').open,toolsOpen:document.querySelector('.preference-agent-tool-guide').open,rulesOpen:document.querySelector('.preference-agent-rules').open};})()");
    assert.ok(dialogBounds.left>=0&&dialogBounds.right<=dialogBounds.width&&dialogBounds.top>=0&&dialogBounds.bottom<=dialogBounds.height); assert.equal(dialogBounds.footerVisible, true); assert.equal(dialogBounds.saveReachable, true);
    assert.equal(dialogBounds.viewportOverflow, false); assert.equal(dialogBounds.panelOverflow, false); assert.equal(dialogBounds.guideOpen, true); assert.equal(dialogBounds.toolsOpen, true); assert.equal(dialogBounds.rulesOpen, true);
    report.checks.narrowDark = { approvalVisible: true, singleColumnPreview: !report.narrowReadability.previewColumns.includes(" "), settingsDialogFits: true, footerReachable: true, saveButtonHitTested: true, expandedGuideNoHorizontalOverflow: true };
    await screenshot("agent-smoke-settings-dark-narrow.png"); await closeModal();
    assert.equal(window.isVisible(), false); assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.resourceErrors, []); assert.deepEqual(report.blockedExternalRequests, []);
    stage = "complete"; console.log("Hidden Agent smoke passed: real native preload, local Agent loop and PowerShell, per-action approval/denial, cancellation, branch isolation, durable trace and unchanged direct chat."); await finish(0);
  } catch (error) { console.error(`Hidden Agent smoke failed during ${stage}:`, error); await finish(1, error); }
});
