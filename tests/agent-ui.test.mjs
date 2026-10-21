import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { AGENT_CAPABILITIES, AGENT_WORKFLOWS, AGENT_EXECUTION_RULES } from "../shared/agent-guide.mjs";

const bundleUrl = new URL(`../artifacts/test-agent-ui-${process.pid}.mjs`, import.meta.url);
const preferencesBundleUrl = new URL(`../artifacts/test-agent-guide-${process.pid}.mjs`, import.meta.url);
let AgentTrace, Preferences, dom, createRoot;
const globals = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

before(async () => {
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await build({ entryPoints: [fileURLToPath(new URL("../src/components/AgentTrace.jsx", import.meta.url))], outfile: fileURLToPath(bundleUrl),
    bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["react", "react/*"], loader: { ".css": "empty" }, logLevel: "silent" });
  await build({ entryPoints: [fileURLToPath(new URL("../src/components/Preferences.jsx", import.meta.url))], outfile: fileURLToPath(preferencesBundleUrl),
    bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["react", "react/*"], loader: { ".css": "empty" }, logLevel: "silent" });
  dom = new JSDOM("<!doctype html><body></body>", { url: "https://agent-ui.example.invalid", pretendToBeVisual: true });
  for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator], ["IS_REACT_ACT_ENVIRONMENT", true]])
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  ({ createRoot } = await import("react-dom/client"));
  ({ default: AgentTrace } = await import(bundleUrl.href));
  ({ default: Preferences } = await import(preferencesBundleUrl.href));
});

after(async () => {
  dom?.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  await rm(bundleUrl, { force: true });
  await rm(preferencesBundleUrl, { force: true });
});

const timestamp = "2026-10-18T08:00:00.000Z";
const makeRun = (overrides = {}) => ({ id: "agent-run-1", engine: "compatible", status: "running", startedAt: timestamp, steps: 2,
  events: [{ id: "read-1", tool: "read_file", status: "completed", summary: "读取 README.md", detail: "模型所需的文件文字", at: timestamp }], artifacts: [], ...overrides });
const makePending = (preview, overrides = {}) => ({ runId: "agent-run-1", callId: "write-1", tool: "write_file", summary: "修改 README.md", preview, ...overrides });

async function fixture(t, props, Component = AgentTrace) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  const rerender = async (next) => act(async () => root.render(React.createElement(Component, next)));
  await rerender(props);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = (label) => {
    const element = [...container.querySelectorAll("button")].find((entry) => entry.textContent.trim() === label);
    assert.ok(element, `missing button: ${label}`);
    return element;
  };
  const click = async (element) => act(async () => { (typeof element === "string" ? button(element) : element).click(); });
  return { container, rerender, button, click };
}

test("Agent history is compact when finished, with tool details available through explicit expansion", async (t) => {
  const view = await fixture(t, { run: makeRun({ status: "completed", finishedAt: timestamp }) });
  const heading = view.container.querySelector(".agent-trace-heading");
  assert.equal(heading.getAttribute("aria-expanded"), "false");
  assert.match(heading.textContent, /Agent · 已完成/);
  assert.match(heading.textContent, /2 步 · 1 次工具/);
  assert.equal(view.container.querySelector(".agent-tool-list"), null);
  await view.click(heading);
  const tool = view.container.querySelector(".agent-tool-heading");
  assert.equal(tool.getAttribute("aria-expanded"), "false");
  await view.click(tool);
  assert.equal(view.container.querySelector(".agent-tool-detail pre").textContent, "模型所需的文件文字");
  assert.equal(view.container.querySelector('[aria-label="待确认操作"]'), null);
});

test("running tasks and running tools stay expanded; completion folds them into saved history", async (t) => {
  const running = makeRun({ events: [{ id: "running-1", tool: "list_files", status: "running", summary: "正在列出文件", at: timestamp }] });
  const view = await fixture(t, { run: running });
  assert.equal(view.container.querySelector(".agent-trace-heading").getAttribute("aria-expanded"), "true");
  assert.equal(view.container.querySelector(".agent-tool-heading").getAttribute("aria-expanded"), "true");
  await view.click(view.container.querySelector(".agent-trace-heading"));
  assert.equal(view.container.querySelector(".agent-trace-heading").getAttribute("aria-expanded"), "true");
  await view.click(view.container.querySelector(".agent-tool-heading"));
  assert.equal(view.container.querySelector(".agent-tool-heading").getAttribute("aria-expanded"), "true");
  await view.rerender({ run: { ...running, status: "completed" } });
  assert.equal(view.container.querySelector(".agent-trace-heading").getAttribute("aria-expanded"), "false");
});

test("write approval shows full before and after text as inert content without truncating the tail", async (t) => {
  const before = '<script>window.compromised = true</script>\n' + "旧".repeat(13000) + "旧文结尾";
  const after = '<img src="https://evil.example.invalid/pixel" onerror="window.compromised=true">\n' + "新".repeat(14000) + "新文结尾";
  const view = await fixture(t, { run: makeRun(), pending: makePending({ kind: "write", path: "README.md", exists: true, before, after }), onDecision() {} });
  const approval = view.container.querySelector('[aria-label="待确认操作"]');
  assert.ok(approval);
  assert.equal(approval.querySelector('[aria-label="修改前的完整内容"] pre').textContent, before);
  assert.equal(approval.querySelector('[aria-label="写入后的完整内容"] pre').textContent, after);
  assert.match(approval.textContent, /仅批准当前操作/);
  assert.equal(approval.querySelectorAll("script, img, iframe, a").length, 0);
  assert.equal(dom.window.compromised, undefined);
});

test("command approval preserves the exact command and explains its real user permissions", async (t) => {
  const command = 'Get-ChildItem -LiteralPath "D:\\Research Files"\nWrite-Output "<b>literal</b>"';
  const view = await fixture(t, { run: makeRun(), pending: makePending({ kind: "command", command, cwd: "project/subdir", timeoutMs: 30000, sandboxed: false }, { tool: "run_command" }), onDecision() {} });
  const approval = view.container.querySelector('[aria-label="待确认操作"]');
  assert.equal(approval.querySelector('[aria-label="待执行的完整命令"] pre').textContent, command);
  assert.match(approval.textContent, /project\/subdir/);
  assert.match(approval.textContent, /30000 ms/);
  assert.match(approval.textContent, /当前系统用户权限运行，不受工作目录沙箱限制/);
  assert.equal(approval.querySelector("b"), null);
});

test("download approval reveals URL, relative target and size limit without loading any remote content", async (t) => {
  const view = await fixture(t, { run: makeRun(), pending: makePending({ kind: "download", path: "downloads/report.pdf", url: "https://example.invalid/report.pdf", maximumBytes: 20971520, executesFile: false }, { tool: "download_file" }), onDecision() {} });
  const approval = view.container.querySelector('[aria-label="待确认操作"]');
  assert.match(approval.textContent, /https:\/\/example.invalid\/report.pdf/);
  assert.match(approval.textContent, /downloads\/report.pdf/);
  assert.match(approval.textContent, /20,971,520 bytes/);
  assert.match(approval.textContent, /不会自动打开或执行/);
  assert.equal(approval.querySelectorAll("a, img, iframe, object").length, 0);
});

test("approval callbacks receive only one boolean decision and cannot be double submitted", async (t) => {
  const decisions = [];
  let finish;
  const props = { run: makeRun(), pending: makePending({ kind: "write", path: "new.txt", exists: false, after: "内容" }), onDecision: (approved) => { decisions.push(approved); return new Promise((resolve) => { finish = resolve; }); } };
  const view = await fixture(t, props);
  assert.equal(view.container.querySelector('[aria-label="修改前的完整内容"]'), null);
  await act(async () => { view.button("允许此次操作").click(); view.button("允许此次操作").click(); view.button("拒绝").click(); });
  assert.deepEqual(decisions, [true]);
  assert.equal(view.button("允许此次操作").disabled, true);
  assert.equal(view.button("拒绝").disabled, true);
  await act(async () => finish());
  assert.equal(view.button("允许此次操作").disabled, true, "successful submission stays locked until pending operation changes");
  await view.rerender({ ...props, pending: { ...props.pending, callId: "write-2" }, onDecision: (approved) => decisions.push(approved) });
  assert.equal(view.button("拒绝").disabled, false);
  await view.click("拒绝");
  assert.deepEqual(decisions, [true, false]);
});

test("busy approvals disable both choices and failed confirmation can be retried", async (t) => {
  let calls = 0;
  const props = { run: makeRun(), pending: makePending({ kind: "write", path: "new.txt", exists: false, after: "" }), busy: true, onDecision: () => { calls++; throw new Error("后台暂不可用"); } };
  const view = await fixture(t, props);
  assert.equal(view.button("允许此次操作").disabled, true);
  assert.equal(view.button("拒绝").disabled, true);
  await view.click("允许此次操作");
  assert.equal(calls, 0);
  await view.rerender({ ...props, busy: false });
  await view.click("允许此次操作");
  assert.equal(calls, 1);
  assert.match(view.container.querySelector('[role="alert"]').textContent, /后台暂不可用/);
  assert.equal(view.button("允许此次操作").disabled, false);
  await view.click("拒绝");
  assert.equal(calls, 2);
});

test("a late response from an older approval never unlocks or reports errors for the next operation", async (t) => {
  let rejectOld;
  const props = { run: makeRun(), pending: makePending({ kind: "write", path: "first.txt", exists: false, after: "first" }),
    onDecision: () => new Promise((resolve, reject) => { rejectOld = reject; }) };
  const view = await fixture(t, props);
  await view.click("允许此次操作");
  assert.equal(view.button("拒绝").disabled, true);
  await view.rerender({ ...props, pending: makePending({ kind: "write", path: "second.txt", exists: false, after: "second" }, { callId: "write-2" }), onDecision: () => new Promise(() => {}) });
  assert.equal(view.button("允许此次操作").disabled, false);
  await view.click("允许此次操作");
  assert.equal(view.button("拒绝").disabled, true);
  await act(async () => rejectOld(new Error("旧操作的网络错误")));
  assert.equal(view.button("拒绝").disabled, true);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.match(view.container.querySelector('[aria-label="待确认操作"]').textContent, /second.txt/);
});

test("historical and mismatched approvals are read-only even if a stale pending object is supplied", async (t) => {
  const pending = makePending({ kind: "command", command: "must never execute" });
  const view = await fixture(t, { run: makeRun({ status: "completed" }), pending, onDecision: () => { throw new Error("must not submit"); } });
  await view.click(view.container.querySelector(".agent-trace-heading"));
  assert.equal(view.container.querySelector('[aria-label="待确认操作"]'), null);
  await view.rerender({ run: makeRun(), pending: { ...pending, runId: "other-run" }, onDecision() {} });
  assert.equal(view.container.querySelector('[aria-label="待确认操作"]'), null);
  await view.rerender({ run: makeRun(), pending });
  assert.match(view.container.querySelector(".agent-approval-unavailable").textContent, /正在执行此任务的会话/);
  assert.equal(view.container.querySelectorAll(".agent-approval-actions button").length, 0);
});

test("interrupted, stopped and failed tasks keep the non-rollback warning visible while collapsed", async (t) => {
  const view = await fixture(t, { run: makeRun({ status: "interrupted" }) });
  assert.match(view.container.querySelector(".agent-trace-heading").textContent, /上次中断/);
  assert.match(view.container.querySelector(".agent-trace-retained").textContent, /尚未确认的操作不会继续执行/);
  for (const status of ["interrupted", "cancelled", "failed"]) {
    await view.rerender({ run: makeRun({ status }) });
    assert.equal(view.container.querySelector(".agent-trace-heading").getAttribute("aria-expanded"), "false");
    assert.match(view.container.querySelector(".agent-trace-retained").textContent, /已完成的文件操作不会自动撤销；再次运行可能重复执行/);
  }
});

test("artifacts display paths as plain text and directory opening passes no model-supplied path", async (t) => {
  let opened = 0;
  const run = makeRun({ status: "completed", artifacts: [{ kind: "file", path: "src/result.js", summary: "生成结果" }, { kind: "download", path: "<img src=x>.zip", summary: "本地下载" }] });
  const view = await fixture(t, { run, onOpenDirectory: (...args) => { assert.equal(args.length, 0); opened++; } });
  assert.equal(opened, 0);
  await view.click(view.container.querySelector(".agent-trace-heading"));
  assert.equal(view.container.querySelectorAll(".agent-artifacts li").length, 2);
  assert.match(view.container.querySelector(".agent-artifacts").textContent, /src\/result.js/);
  assert.match(view.container.querySelector(".agent-artifacts").textContent, /<img src=x>.zip/);
  assert.equal(view.container.querySelectorAll("a, img, iframe").length, 0);
  await view.click("打开工作目录");
  assert.equal(opened, 1);
});

test("saved tool details are bounded and unknown approval previews remain inert JSON", async (t) => {
  const detail = "x".repeat(13000);
  const view = await fixture(t, { run: makeRun({ events: [{ id: "long-tool", tool: "custom_tool", status: "completed", summary: "自定义操作", detail, at: timestamp }] }), pending: makePending({ kind: "custom", html: "<script>never execute</script>", array: [1, "text"] }, { tool: "custom_tool" }) });
  assert.match(view.container.querySelector(".agent-preview-json").textContent, /<script>never execute<\/script>/);
  assert.equal(view.container.querySelector("script"), null);
  await view.click(view.container.querySelector(".agent-tool-heading"));
  assert.equal(view.container.querySelector(".agent-tool-detail pre").textContent.length, 12000);
  assert.match(view.container.querySelector(".agent-tool-detail small").textContent, /12,000/);
});

test("local edits show replacement count and retain complete before and after approval", async (t) => {
  const before = "first target\nsecond target\nunchanged";
  const after = "first result\nsecond result\nunchanged";
  const view = await fixture(t, { run: makeRun({ events: [{ id: "edit-1", tool: "edit_file", status: "awaiting-approval", at: timestamp }] }),
    pending: makePending({ kind: "write", path: "notes.md", exists: true, before, after, replacements: 2 }, { tool: "edit_file" }), onDecision() {} });
  const approval = view.container.querySelector('[aria-label="待确认操作"]');
  assert.match(approval.textContent, /局部替换（2 处）/);
  assert.doesNotMatch(approval.textContent, /替换已有文件内容/);
  assert.equal(approval.querySelector('[aria-label="修改前的完整内容"] pre').textContent, before);
  assert.equal(approval.querySelector('[aria-label="写入后的完整内容"] pre').textContent, after);
  assert.match(view.container.querySelector(".agent-tool-label").textContent, /局部编辑文件/);
});

test("directory creation approval exposes exact inert path and does not imply recursive creation", async (t) => {
  const path = "reports/<script>literal</script>";
  const view = await fixture(t, { run: makeRun({ events: [{ id: "mkdir-1", tool: "create_directory", status: "awaiting-approval", at: timestamp }] }),
    pending: makePending({ kind: "directory", path }, { tool: "create_directory", summary: "创建目录" }), onDecision() {} });
  const approval = view.container.querySelector('[aria-label="待确认操作"]');
  assert.equal(approval.querySelector("code").textContent, path);
  assert.match(approval.textContent, /创建单层目录/);
  assert.match(approval.textContent, /父目录必须已经存在/);
  assert.equal(approval.querySelector("script"), null);
  assert.equal(approval.querySelector(".agent-preview-json"), null);
  assert.match(view.container.querySelector(".agent-tool-label").textContent, /创建目录/);
});

async function guideFixture(t, overrides = {}) {
  const initial = { agentAvailable: true, agentEnabled: true, agentWorkspace: "D:\\Agent Project", agentAllowCommands: false,
    agentAllowNetwork: false, agentSearchEndpoint: "", ...overrides };
  const calls = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(url, "/api/settings");
    assert.equal(options.method ?? "GET", "GET");
    return Response.json(initial);
  };
  t.after(() => { globalThis.fetch = priorFetch; });
  const view = await fixture(t, { Modal: ({ children }) => React.createElement("section", null, children), initial, initialSection: "agent", onSaved() {}, close() {} }, Preferences);
  const toggle = async (label) => {
    const control = [...view.container.querySelectorAll(".preference-toggle")].find((entry) => entry.querySelector("strong").textContent === label);
    assert.ok(control, `missing toggle: ${label}`);
    await view.click(control.querySelector("input"));
  };
  const input = async (name, value) => act(async () => {
    const element = view.container.querySelector(`[name="${name}"]`);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const statuses = (requirement) => [...view.container.querySelectorAll(`[data-requirement="${requirement}"] .preference-agent-status`)];
  return { ...view, calls, toggle, input, statuses };
}

test("Agent capability guide stays compact, maps real workflows and never calls tools on expansion", async (t) => {
  const view = await guideFixture(t);
  const guide = view.container.querySelector('[aria-label="Agent 能力指南"]');
  assert.equal(guide.open, false);
  await view.click(guide.querySelector("summary"));
  assert.equal(guide.open, true);
  assert.deepEqual([...guide.querySelectorAll("[data-agent-workflow]")].map((entry) => entry.dataset.agentWorkflow), AGENT_WORKFLOWS.map((entry) => entry.id));
  assert.deepEqual([...guide.querySelectorAll("[data-agent-capability]")].map((entry) => entry.dataset.agentCapability), AGENT_CAPABILITIES.map((entry) => entry.id));
  for (const entry of AGENT_WORKFLOWS) {
    const item = guide.querySelector(`[data-agent-workflow="${entry.id}"]`);
    assert.equal(item.querySelector("code").textContent, entry.tools.join(" → "));
    assert.equal(item.querySelector("blockquote").textContent, entry.example);
  }
  assert.match(guide.textContent, /保存后生效/);
  assert.match(guide.textContent, /PDF、Office、图像转换/);
  assert.match(guide.textContent, /不能登录、点击网页/);
  const rules = guide.querySelector(".preference-agent-rules");
  assert.equal(rules.open, false);
  await view.click(rules.querySelector("summary"));
  assert.equal(rules.open, true);
  assert.equal(rules.querySelector("pre").textContent, AGENT_EXECUTION_RULES);
  assert.equal(view.calls.length, 1, "opening the guide only reads existing settings");
});

test("Agent guide reflects command, network and search prerequisites without promising verified execution", async (t) => {
  const view = await guideFixture(t);
  const allState = (requirement, expected) => {
    assert.ok(view.statuses(requirement).length > 0, `missing requirement: ${requirement}`);
    for (const status of view.statuses(requirement)) assert.equal(status.dataset.state, expected);
  };
  allState("files", "ready");
  for (const requirement of ["commands", "network", "search"]) allState(requirement, "blocked");
  await view.toggle("允许运行命令");
  allState("commands", "ready");
  await view.toggle("允许网络搜索与下载");
  allState("network", "ready");
  allState("search", "blocked");
  assert.ok(view.statuses("search").every((entry) => entry.textContent === "需配置搜索服务"));
  await view.input("agentSearchEndpoint", "https://search.example.invalid/search");
  allState("search", "ready");
  await view.toggle("启用可选 Agent 后台");
  for (const status of view.container.querySelectorAll(".preference-agent-status")) {
    assert.equal(status.dataset.state, "blocked");
    assert.equal(status.textContent, "需启用 Agent");
  }
  assert.equal(view.calls.length, 1);
});

test("Agent guide remains readable in browser mode and reports missing workspace before file availability", async (t) => {
  const view = await guideFixture(t, { agentAvailable: false });
  const guide = view.container.querySelector('[aria-label="Agent 能力指南"]');
  await view.click(guide.querySelector("summary"));
  assert.equal(guide.open, true);
  assert.ok([...view.container.querySelectorAll(".preference-agent-status")].every((entry) => entry.textContent === "需桌面应用"));
});

test("Agent guide requires a selected workspace for otherwise enabled tools", async (t) => {
  const view = await guideFixture(t, { agentWorkspace: "", agentAllowCommands: true, agentAllowNetwork: true, agentSearchEndpoint: "https://search.example.invalid/search" });
  assert.ok([...view.container.querySelectorAll(".preference-agent-status")].every((entry) => entry.textContent === "需选择工作目录"));
});
