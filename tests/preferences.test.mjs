import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, formatShortcut } from "../shared/shortcuts.mjs";

const bundleUrl = new URL(`../artifacts/test-preferences-${process.pid}.mjs`, import.meta.url);
let Preferences;

before(async () => {
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL("../src/components/Preferences.jsx", import.meta.url))],
    outfile: fileURLToPath(bundleUrl), bundle: true, format: "esm", platform: "browser", target: "es2022",
    external: ["react", "react/*"], loader: { ".css": "empty" }, logLevel: "silent",
  });
  ({ default: Preferences } = await import(bundleUrl.href));
});

after(() => rm(bundleUrl, { force: true }));

const savedDefaults = {
  baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", systemPrompt: "", temperature: 0.7,
  rememberKey: false, theme: "system", fontSize: 16, lineHeight: 1.8, codeWrap: false,
  reduceMotion: false, panelWidth: 560, sendOnEnter: true, showMinimap: true, autoSummary: true, autoSummaryMaterials:false, autoLayout:true,
  summaryMaxLength: 160, maxOutputTokens: 0, requestTimeoutSeconds: 120,
  agentEnabled: false, agentEngine: "compatible", agentWorkspace: "", agentAllowCommands: false,
  agentAllowNetwork: false, agentSearchEndpoint: "", agentMaxSteps: 12,
  hasApiKey: false, keyStorage: "encrypted", dataDirectory: "C:\\BranchLocal\\data", shortcuts: DEFAULT_SHORTCUTS,
};

async function fixture(t, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://branch-local.example" });
  const keys = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [];
  const saved = [];
  const directoryChanges = [];
  let closed = 0;
  let state = { ...savedDefaults, ...options.initial };
  let root;
  const fetchMock = async (url, input = {}) => {
    const method = input.method ?? "GET";
    const body = input.body ? JSON.parse(input.body) : undefined;
    calls.push({ url, method, body, signal: input.signal });
    if (options.fetch) return options.fetch({ url, method, body, signal: input.signal, calls, state });
    if (url === "/api/settings" && method === "GET") return Response.json(state);
    if (url === "/api/settings" && method === "PUT") {
      const { apiKey, clearApiKey, ...settings } = body;
      state = { ...state, ...settings, hasApiKey: clearApiKey ? Boolean(apiKey) : Boolean(apiKey || state.hasApiKey) };
      return Response.json(state);
    }
    if (url === "/api/models" && method === "POST") return Response.json({ models: ["local-first", "local-second"] });
    throw new Error(`Unexpected mock route ${method} ${url}`);
  };
  for (const [key, value] of [
    ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
    ["fetch", fetchMock], ["IS_REACT_ACT_ENVIRONMENT", true],
  ]) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  if (options.desktop) dom.window.branchDesktop = options.desktop;
  const Modal = ({ title, children }) => React.createElement("section", { role: "dialog", "aria-label": title }, children);
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  // Load React DOM after installing JSDOM so its input-event feature detection uses a real document.
  const { createRoot } = await import("react-dom/client");
  root = createRoot(dom.window.document.querySelector("#root"));
  await act(async () => {
    root.render(React.createElement(Preferences, {
      Modal, initial: state, close: () => { closed++; },
      initialSection: options.initialSection,
      onSaved: async (value) => { saved.push(value); await options.onSaved?.(value); },
      changeStorage: options.noChangeStorage ? undefined : async (value) => {
        directoryChanges.push(value);
        await options.changeStorage?.(value);
      },
    }));
  });
  const document = dom.window.document;
  const button = (text) => {
    const element = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
    assert.ok(element, `missing button: ${text}`);
    return element;
  };
  const click = async (target) => {
    const element = typeof target === "string" ? button(target) : target;
    await act(async () => { element.click(); await new Promise((resolve) => setImmediate(resolve)); });
  };
  const set = async (name, value) => {
    const element = document.querySelector(`[name="${name}"]`);
    assert.ok(element, `missing field: ${name}`);
    const prototype = element.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype
      : element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, String(value));
      element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  const toggle = async (label) => {
    const element = [...document.querySelectorAll(".preference-toggle")].find((item) => item.querySelector("strong")?.textContent === label);
    assert.ok(element, `missing toggle: ${label}`);
    await click(element.querySelector('input[type="checkbox"]'));
  };
  return { dom, document, calls, saved, directoryChanges, click, set, toggle, button,
    closed: () => closed, unmount: async () => { await act(async () => root.unmount()); root = null; } };
}

test("preferences expose seven accessible tabs, their actual controls and keyboard navigation", async (t) => {
  const view = await fixture(t);
  const { document, click } = view;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map((tab) => tab.textContent), ["模型连接", "阅读", "交互", "生成与总结", "Agent", "本地数据", "快捷键"]);
  assert.equal(document.querySelector('[role="dialog"]').getAttribute("aria-label"), "应用设置");
  assert.equal(document.querySelector('[name="baseUrl"]').value, savedDefaults.baseUrl);
  for (const [label, field] of [["阅读", "fontSize"], ["交互", "panelWidth"], ["生成与总结", "summaryMaxLength"], ["Agent", "agentWorkspace"], ["本地数据", "dataDirectory"]]) {
    await click(label);
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    assert.equal(selected.textContent, label);
    assert.equal(selected.tabIndex, 0);
    assert.equal(document.querySelector('[role="tabpanel"]').getAttribute("aria-labelledby"), selected.id);
    assert.ok(document.querySelector(`[name="${field}"]`));
  }
  await click("快捷键");
  assert.equal(document.querySelectorAll("[data-shortcut-action]").length, SHORTCUT_ACTIONS.length);
  await act(async () => tabs[6].dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, "模型连接");
  assert.equal(document.activeElement, tabs[0]);
  await act(async () => tabs[0].dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true })));
  assert.equal(document.activeElement, tabs[6]);
  await act(async () => tabs[6].dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  assert.equal(document.activeElement, tabs[0]);
});

test("editing and saving fields across tabs sends real typed settings and applies the returned state", async (t) => {
  const view = await fixture(t);
  await view.set("baseUrl", "https://models.example.invalid/v1");
  await view.set("model", "chosen-model");
  await view.set("apiKey", "unit-test-key");
  await view.set("systemPrompt", "保留公式并清晰回答。");
  await view.set("temperature", 0.3);
  await view.toggle("在此电脑记住密钥");
  await view.click("阅读");
  await view.set("theme", "dark");
  await view.set("fontSize", 19);
  await view.set("lineHeight", 2.1);
  await view.toggle("代码自动折行");
  await view.toggle("减少动画");
  assert.equal(view.document.querySelector(".preference-reading-preview").style.fontSize, "19px");
  await view.click("交互");
  await view.set("panelWidth", 1000);
  await view.toggle("按 Enter 发送消息");
  await view.toggle("显示画布缩略地图");
  await view.toggle("新建分支后自动布局");
  await view.click("生成与总结");
  await view.toggle("自动生成有区分性的总结");
  await view.set("summaryMaxLength", 240);
  await view.set("maxOutputTokens", 4096);
  await view.set("requestTimeoutSeconds", 300);
  await view.click("保存设置");
  const put = view.calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body, {
    baseUrl: "https://models.example.invalid/v1", model: "chosen-model", systemPrompt: "保留公式并清晰回答。", temperature: 0.3,
    rememberKey: true, theme: "dark", fontSize: 19, lineHeight: 2.1, codeWrap: true, reduceMotion: true,
    panelWidth: 1000, sendOnEnter: false, showMinimap: false, autoSummary: false, autoSummaryMaterials:false, autoLayout:false, summaryMaxLength: 240,
    maxOutputTokens: 4096, requestTimeoutSeconds: 300, apiKey: "unit-test-key", clearApiKey: false, shortcuts: DEFAULT_SHORTCUTS,
    agentEnabled: false, agentEngine: "compatible", agentWorkspace: "", agentAllowCommands: false,
    agentAllowNetwork: false, agentSearchEndpoint: "", agentMaxSteps: 12,
  });
  assert.equal(view.saved.length, 1);
  assert.equal(view.saved[0].model, "chosen-model");
  assert.equal(view.saved[0].hasApiKey, true);
  assert.equal(view.closed(), 1);
  assert.equal(view.document.querySelector('[role="alert"]'), null);
});

test("an in-flight settings save disables editing until its response is applied, preventing lost edits", async (t) => {
  let finishSave;
  const view = await fixture(t, { fetch: async ({ method, body, state }) => {
    if (method === "PUT") return new Promise((resolve) => { finishSave = () => resolve(Response.json({ ...state, ...body, apiKey: undefined })); });
    return Response.json(state);
  } });
  await view.set("model", "value-being-saved");
  await view.click("保存设置");
  assert.ok(finishSave);
  assert.equal(view.document.querySelector("fieldset").getAttribute("aria-busy"), "true");
  for (const control of view.document.querySelectorAll("fieldset input, fieldset textarea, fieldset button"))
    assert.equal(control.matches(":disabled"), true, `${control.tagName} must be disabled while saving`);
  const provider = view.button("兼容 OpenAI 的 API连接自己的模型服务");
  await view.click(provider);
  assert.equal(view.document.querySelector('[name="model"]').value, "value-being-saved");
  await act(async () => finishSave());
  assert.equal(view.document.querySelector('[name="model"]').matches(":disabled"), false);
  assert.equal(view.saved[0].model, "value-being-saved");
  await view.click("阅读");
  assert.equal(view.document.querySelector('[name="theme"]').matches(":disabled"), false);
});

test("model discovery saves provider settings, clears the old provider key and allows choosing a model from an initially blank field", async (t) => {
  const view = await fixture(t, { initial: { hasApiKey: true } });
  await view.click("兼容 OpenAI 的 API连接自己的模型服务");
  assert.equal(view.document.querySelector('[name="baseUrl"]').value, "");
  assert.equal(view.document.querySelector('[name="model"]').value, "");
  await view.set("baseUrl", "https://new-provider.example.invalid/v1");
  await view.click("保存设置并读取模型");
  assert.deepEqual(view.calls.map(({ method, url }) => `${method} ${url}`), ["GET /api/settings", "PUT /api/settings", "POST /api/models"]);
  const payload = view.calls[1].body;
  assert.equal(payload.clearApiKey, true);
  assert.equal(Object.hasOwn(payload, "model"), false);
  assert.equal(payload.apiKey, "");
  assert.deepEqual([...view.document.querySelectorAll("datalist option")].map((option) => option.value), ["local-first", "local-second"]);
  assert.equal(view.document.querySelector('[name="model"]').value, "");
  assert.match(view.document.querySelector('[role="status"]').textContent, /已读取 2 个模型/);
  assert.equal(view.closed(), 0);
  await view.set("model", "local-second");
  await view.click("保存设置");
  assert.equal(view.calls.at(-1).body.model, "local-second");
  assert.equal(view.saved.at(-1).hasApiKey, false);
  assert.equal(view.closed(), 1);
});

test("model-list failures state that settings were saved, and invalid numeric settings never reach the backend", async (t) => {
  const view = await fixture(t, { fetch: async ({ url, method, body, state }) => {
    if (url === "/api/models") return Response.json({ error: "模型服务离线" }, { status: 502 });
    return Response.json(method === "PUT" ? { ...state, ...body, apiKey: undefined, clearApiKey: undefined } : state);
  } });
  await view.click("保存设置并读取模型");
  assert.match(view.document.querySelector('[role="alert"]').textContent, /设置已保存，读取模型失败：模型服务离线/);
  assert.equal(view.saved.length, 1);
  assert.equal(view.closed(), 0);
  await view.click("阅读");
  await view.set("fontSize", "");
  await view.click("模型连接");
  const before = view.calls.length;
  await view.click("保存设置并读取模型");
  assert.equal(view.calls.length, before);
  assert.equal(view.document.querySelector('[role="tab"][aria-selected="true"]').textContent, "阅读");
  assert.match(view.document.querySelector('[role="alert"]').textContent, /正文字号需要填写 12–24/);
});

test("a late settings refresh cannot overwrite user edits and unmount cancels refresh requests", async (t) => {
  let resolveRefresh;
  const view = await fixture(t, { fetch: ({ signal }) => new Promise((resolve, reject) => {
    resolveRefresh = resolve;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }) });
  await view.set("model", "edited-before-refresh");
  await act(async () => { resolveRefresh(Response.json({ ...savedDefaults, model: "late-server-model" })); });
  assert.equal(view.document.querySelector('[name="model"]').value, "edited-before-refresh");
  assert.equal(view.calls[0].signal.aborted, false);
  await view.unmount();
  assert.equal(view.calls[0].signal.aborted, true);
});

test("native data-directory flows distinguish copying an empty directory and loading existing data without opening real windows", async (t) => {
  const selected = [
    { directory: "D:\\BranchLocal New", hasWorkspace: false },
    { directory: "E:\\Existing Conversation Data", hasWorkspace: true },
  ];
  let opened = 0;
  let chosen = 0;
  const view = await fixture(t, { desktop: {
    openDataDirectory: async () => { opened++; },
    chooseDataDirectory: async () => { chosen++; return selected.shift(); },
  } });
  await view.click("本地数据");
  assert.equal(view.document.querySelector('[name="dataDirectory"]').value, savedDefaults.dataDirectory);
  assert.equal(view.document.querySelector('[name="dataDirectory"]').readOnly, true);
  await view.click("打开目录");
  assert.equal(opened, 1);
  await view.click("选择其他目录");
  assert.equal(view.document.querySelector('[name="storageMode"][value="copy"]').checked, true);
  assert.equal(view.document.querySelector('[name="storageMode"][value="existing"]').disabled, true);
  await view.click("使用此目录并重新载入");
  assert.deepEqual(view.directoryChanges, [{ directory: "D:\\BranchLocal New", mode: "copy" }]);
  assert.equal(view.document.querySelector(".preference-storage-choice"), null);
  assert.match(view.document.querySelector('[role="status"]').textContent, /已切换数据目录/);
  await view.click("选择其他目录");
  assert.equal(view.document.querySelector('[name="storageMode"][value="existing"]').checked, true);
  assert.equal(view.document.querySelector('[name="storageMode"][value="copy"]').disabled, true);
  await view.click("使用此目录并重新载入");
  assert.deepEqual(view.directoryChanges.at(-1), { directory: "E:\\Existing Conversation Data", mode: "existing" });
  assert.equal(chosen, 2);
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0, "storage changes go through the app's flush-and-reload owner");
});

test("data-directory failures remain visible and retryable while cancelling selection changes no data", async (t) => {
  let choice = { directory: "D:\\Retry Data", hasWorkspace: false };
  let fail = true;
  const view = await fixture(t, {
    desktop: { chooseDataDirectory: async () => choice },
    changeStorage: async () => { if (fail) throw new Error("目标目录不可写"); },
  });
  await view.click("本地数据");
  await view.click("选择其他目录");
  await view.click("使用此目录并重新载入");
  assert.match(view.document.querySelector('[role="alert"]').textContent, /切换数据目录失败：目标目录不可写/);
  assert.ok(view.document.querySelector(".preference-storage-choice"));
  assert.equal(view.button("使用此目录并重新载入").disabled, false);
  fail = false;
  await view.click("使用此目录并重新载入");
  assert.equal(view.directoryChanges.length, 2);
  choice = null;
  await view.click("选择其他目录");
  assert.equal(view.document.querySelector(".preference-storage-choice"), null);
  assert.equal(view.directoryChanges.length, 2);
});

test("a pending native data-directory switch locks controls until the app has completed its flush and reload step", async (t) => {
  let finishSwitch;
  const view = await fixture(t, {
    desktop: { chooseDataDirectory: async () => ({ directory: "D:\\Pending Data", hasWorkspace: false }) },
    changeStorage: async () => new Promise((resolve) => { finishSwitch = resolve; }),
  });
  await view.click("本地数据");
  await view.click("选择其他目录");
  await view.click("使用此目录并重新载入");
  assert.ok(finishSwitch);
  assert.equal(view.document.querySelector('[name="dataDirectory"]').matches(":disabled"), true);
  assert.equal(view.document.querySelector('[name="storageMode"][value="copy"]').matches(":disabled"), true);
  assert.equal(view.button("模型连接").matches(":disabled"), true);
  assert.equal(view.button("保存设置").disabled, true);
  await act(async () => finishSwitch());
  assert.equal(view.document.querySelector('[name="dataDirectory"]').matches(":disabled"), false);
  assert.equal(view.button("保存设置").disabled, false);
});

test("browser mode explains native directory support and never exposes an inactive directory picker", async (t) => {
  const view = await fixture(t);
  await view.click("本地数据");
  assert.match(view.document.querySelector(".preference-unavailable").textContent, /更换数据目录需要桌面应用/);
  assert.equal([...view.document.querySelectorAll("button")].some((button) => button.textContent.includes("选择其他目录")), false);
});

test("Agent stays optional, selects a native directory without saving and persists typed permissions", async (t) => {
  let chosen = 0;
  const view = await fixture(t, { initial: { agentAvailable: true }, desktop: {
    chooseAgentDirectory: async () => { chosen++; return { canceled: false, directory: "D:\\Research Files" }; },
  } });
  await view.click("Agent");
  const workspace = () => view.document.querySelector('[name="agentWorkspace"]');
  assert.equal(workspace().readOnly, true);
  assert.equal(workspace().matches(":disabled"), true);
  assert.match(view.document.querySelector('[aria-label="Agent 开关"]').textContent, /仍默认直接聊天/);
  await view.toggle("启用可选 Agent 后台");
  assert.equal(workspace().matches(":disabled"), false);
  await view.click("选择 Agent 工作目录");
  assert.equal(chosen, 1);
  assert.equal(workspace().value, "D:\\Research Files");
  assert.equal(view.directoryChanges.length, 0, "Agent workspace selection must not move local conversation data");
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
  assert.equal(view.document.querySelector('[name="agentSearchEndpoint"]').disabled, true);
  await view.toggle("允许运行命令");
  await view.toggle("允许网络搜索与下载");
  assert.equal(view.document.querySelector('[name="agentSearchEndpoint"]').disabled, false);
  await view.set("agentSearchEndpoint", "https://search.example.invalid/searxng");
  await view.set("agentMaxSteps", 24);
  assert.match(view.document.querySelector('[aria-label="Agent 工具权限"]').textContent, /当前系统用户运行，不受工作目录沙箱限制/);
  assert.match(view.document.querySelector('[aria-label="Agent 执行边界"]').textContent, /分|写入/);
  await view.click("保存设置");
  const payload = view.calls.find((call) => call.method === "PUT").body;
  assert.equal(payload.agentEnabled, true);
  assert.equal(payload.agentEngine, "compatible");
  assert.equal(payload.agentWorkspace, "D:\\Research Files");
  assert.equal(payload.agentAllowCommands, true);
  assert.equal(payload.agentAllowNetwork, true);
  assert.equal(payload.agentSearchEndpoint, "https://search.example.invalid/searxng");
  assert.equal(payload.agentMaxSteps, 24);
  assert.equal(Object.hasOwn(payload, "agentAvailable"), false);
  assert.equal(view.closed(), 1);
});

test("disabling Agent preserves its directory and permissions, while cancellation preserves the previous folder", async (t) => {
  const view = await fixture(t, { initial: {
    agentEnabled: true, agentWorkspace: "D:\\Existing Agent", agentAllowCommands: true, agentAllowNetwork: true,
  }, desktop: { chooseAgentDirectory: async () => ({ canceled: true, directory: "" }) } });
  await view.click("Agent");
  await view.click("选择 Agent 工作目录");
  assert.equal(view.document.querySelector('[name="agentWorkspace"]').value, "D:\\Existing Agent");
  await view.toggle("启用可选 Agent 后台");
  assert.equal(view.document.querySelector('[name="agentWorkspace"]').matches(":disabled"), true);
  await view.click("保存设置");
  assert.equal(view.saved[0].agentEnabled, false);
  assert.equal(view.saved[0].agentWorkspace, "D:\\Existing Agent");
  assert.equal(view.saved[0].agentAllowCommands, true);
  assert.equal(view.saved[0].agentAllowNetwork, true);
});

test("Agent availability is desktop-only, explicit service denial overrides native picker presence", async (t) => {
  const view = await fixture(t, { initial: { agentAvailable: false }, desktop: {
    chooseAgentDirectory: async () => { throw new Error("must not open"); },
  } });
  await view.click("Agent");
  assert.match(view.document.querySelector(".preference-unavailable").textContent, /需要桌面应用/);
  const toggle = [...view.document.querySelectorAll(".preference-toggle")].find((item) => item.querySelector("strong").textContent === "启用可选 Agent 后台").querySelector("input");
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.checked, false);
  await view.toggle("启用可选 Agent 后台");
  assert.equal(toggle.checked, false);
  assert.equal(view.button("选择 Agent 工作目录").matches(":disabled"), true);
});

test("Agent setup validates its folder, HTTPS search address and step budget before saving", async (t) => {
  const view = await fixture(t, { desktop: {
    chooseAgentDirectory: async () => ({ canceled: false, directory: "D:\\Agent" }),
  } });
  await view.click("Agent");
  await view.toggle("启用可选 Agent 后台");
  await view.click("保存设置");
  assert.match(view.document.querySelector('[role="alert"]').textContent, /选择工作目录/);
  await view.click("选择 Agent 工作目录");
  await view.toggle("允许网络搜索与下载");
  for (const invalid of ["http://search.example.invalid", "https://user:password@search.example.invalid", "https://search.example.invalid/?q=secret", "https://search.example.invalid/#fragment"]) {
    await view.set("agentSearchEndpoint", invalid);
    await view.click("保存设置");
    assert.match(view.document.querySelector('[role="alert"]').textContent, /有效的 HTTPS SearXNG/);
  }
  await view.set("agentSearchEndpoint", "");
  await view.set("agentMaxSteps", "");
  await view.click("模型连接");
  await view.click("保存设置");
  assert.equal(view.document.querySelector('[role="tab"][aria-selected="true"]').textContent, "Agent");
  assert.match(view.document.querySelector('[role="alert"]').textContent, /1–30/);
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
  await view.set("agentMaxSteps", 1);
  await view.click("保存设置");
  assert.equal(view.saved[0].agentMaxSteps, 1);
  assert.equal(view.saved[0].agentSearchEndpoint, "");
});

test("native Agent directory errors are visible and in-flight selection prevents conflicting saves", async (t) => {
  let finish;
  let failed = false;
  const view = await fixture(t, { initial: { agentEnabled: true, agentWorkspace: "D:\\Old" }, desktop: {
    chooseAgentDirectory: async () => {
      if (failed) throw new Error("文件夹不可访问");
      return new Promise((resolve) => { finish = resolve; });
    },
  } });
  await view.click("Agent");
  await view.click("选择 Agent 工作目录");
  assert.equal(view.button("保存设置").disabled, true);
  assert.equal(view.button("本地数据").matches(":disabled"), true);
  await act(async () => finish({ canceled: true, directory: "" }));
  assert.equal(view.button("保存设置").disabled, false);
  failed = true;
  await view.click("选择 Agent 工作目录");
  assert.match(view.document.querySelector('[role="alert"]').textContent, /选择 Agent 工作目录失败：文件夹不可访问/);
  assert.equal(view.document.querySelector('[name="agentWorkspace"]').value, "D:\\Old");
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
});

test("Agent settings support direct navigation and opening only the saved native directory", async (t) => {
  let opened = 0;
  const view = await fixture(t, { initialSection: "agent", initial: {
    agentEnabled: true, agentWorkspace: "D:\\Saved Agent",
  }, desktop: {
    chooseAgentDirectory: async () => ({ canceled: false, directory: "D:\\New Agent" }),
    openAgentDirectory: async (...arguments_) => { assert.equal(arguments_.length, 0); opened++; },
  } });
  assert.equal(view.document.querySelector('[role="tab"][aria-selected="true"]').textContent, "Agent");
  await view.click("打开 Agent 工作目录");
  assert.equal(opened, 1);
  await view.click("选择 Agent 工作目录");
  assert.equal(view.button("打开 Agent 工作目录").disabled, true);
  assert.match(view.document.querySelector('[aria-label="Agent 引擎与目录"]').textContent, /保存设置后可打开/);
  assert.equal(opened, 1);
});

test("unknown settings destinations fall back to the model tab", async (t) => {
  const view = await fixture(t, { initialSection: "unsupported" });
  assert.equal(view.document.querySelector('[role="tab"][aria-selected="true"]').textContent, "模型连接");
});

const shortcutAction = (id) => {
  const action = SHORTCUT_ACTIONS.find((item) => item.id === id);
  assert.ok(action, `missing registered shortcut: ${id}`);
  return action;
};
const shortcutControl = (view, id, type = "录制") => {
  const action = shortcutAction(id);
  const button = view.document.querySelector(`[aria-label="${type}快捷键：${action.label}"]`);
  assert.ok(button, `missing ${type} control for ${id}`);
  return button;
};
const shortcutRow = (view, id) => view.document.querySelector(`[data-shortcut-action="${id}"]`);
async function recordKey(view, options) {
  const event = new view.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
  await act(async () => { (view.document.activeElement || view.document.body).dispatchEvent(event); });
  return event;
}

test("shortcut recording captures Ctrl combinations without executing application handlers and saves only on explicit save", async (t) => {
  const view = await fixture(t);
  await view.click("快捷键");
  const expectedGroups = new Set(SHORTCUT_ACTIONS.map((action) => action.group));
  assert.equal(view.document.querySelectorAll(".shortcut-group").length, expectedGroups.size);
  let applicationEvents = 0;
  view.dom.window.addEventListener("keydown", () => { applicationEvents++; });
  await view.click(shortcutControl(view, "branch"));
  const modifier = await recordKey(view, { key: "Control", ctrlKey: true });
  assert.equal(modifier.defaultPrevented, true);
  assert.equal(shortcutControl(view, "branch").getAttribute("aria-pressed"), "true");
  await recordKey(view, { key: "b", code: "KeyB", ctrlKey: true });
  assert.equal(applicationEvents, 0);
  assert.equal(shortcutRow(view, "branch").querySelector("kbd").textContent, formatShortcut("Ctrl+B"));
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
  assert.equal(view.saved.length, 0);
  await view.click("保存设置");
  assert.equal(view.calls.at(-1).body.shortcuts.branch, "Ctrl+B");
  assert.equal(view.saved[0].shortcuts.branch, "Ctrl+B");
  assert.equal(view.closed(), 1);
});

test("shortcut conflicts name the other action, unsupported keys keep old bindings and Escape cancels without closing the modal", async (t) => {
  const view = await fixture(t);
  await view.click("快捷键");
  let modalEscapes = 0;
  view.dom.window.addEventListener("keydown", (event) => { if (event.key === "Escape") modalEscapes++; });
  await view.click(shortcutControl(view, "branch"));
  await recordKey(view, { key: "F2", code: "F2" });
  assert.ok(view.document.querySelector('[role="alert"]').textContent.includes(shortcutAction("rename").label));
  assert.equal(shortcutControl(view, "branch").getAttribute("aria-pressed"), "true");
  await recordKey(view, { key: "b", altKey: true });
  assert.match(view.document.querySelector('[role="alert"]').textContent, /不支持 Alt/);
  await recordKey(view, { key: "c", code: "KeyC", ctrlKey: true });
  assert.match(view.document.querySelector('[role="alert"]').textContent, /复制、粘贴或剪切/);
  await recordKey(view, { key: "b", code: "KeyB", shiftKey: true });
  assert.match(view.document.querySelector('[role="alert"]').textContent, /必须包含 Ctrl/);
  const escape = await recordKey(view, { key: "Escape", code: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(modalEscapes, 0);
  assert.equal(view.closed(), 0);
  assert.equal(shortcutRow(view, "branch").querySelector("kbd").textContent, formatShortcut(DEFAULT_SHORTCUTS.branch));
  assert.match(view.document.querySelector('[role="status"]').textContent, /取消录制/);
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
});

test("shortcuts can clear, record Delete and restore individual or all defaults while preserving conflict safety", async (t) => {
  const view = await fixture(t);
  await view.click("快捷键");
  await view.click(shortcutControl(view, "trash", "清除"));
  assert.equal(shortcutRow(view, "trash").querySelector("kbd"), null);
  assert.match(shortcutRow(view, "trash").textContent, /未设置/);
  await view.click(shortcutControl(view, "trash"));
  await recordKey(view, { key: "Delete", code: "Delete" });
  assert.equal(shortcutRow(view, "trash").querySelector("kbd").textContent, formatShortcut("Delete"));
  await view.click(shortcutControl(view, "rename", "清除"));
  await view.click(shortcutControl(view, "branch"));
  await recordKey(view, { key: "F2", code: "F2" });
  await view.click(shortcutControl(view, "rename", "恢复默认"));
  assert.ok(view.document.querySelector('[role="alert"]').textContent.includes(shortcutAction("branch").label));
  assert.equal(shortcutRow(view, "rename").querySelector("kbd"), null);
  await view.click(shortcutControl(view, "branch", "清除"));
  await view.click(shortcutControl(view, "rename", "恢复默认"));
  assert.equal(shortcutRow(view, "rename").querySelector("kbd").textContent, formatShortcut("F2"));
  await view.click("恢复全部默认快捷键");
  for (const action of SHORTCUT_ACTIONS) {
    const key = shortcutRow(view, action.id).querySelector("kbd");
    assert.equal(key?.textContent || "", action.defaultBinding ? formatShortcut(action.defaultBinding) : "");
  }
  await view.click("保存设置");
  assert.deepEqual(view.calls.at(-1).body.shortcuts, DEFAULT_SHORTCUTS);
});

test("cleared bindings and initial overrides persist through the settings response", async (t) => {
  const view = await fixture(t, { initial: { shortcuts: { ...DEFAULT_SHORTCUTS, branch: "Ctrl+B" } } });
  await view.click("快捷键");
  assert.equal(shortcutRow(view, "branch").querySelector("kbd").textContent, formatShortcut("Ctrl+B"));
  await view.click(shortcutControl(view, "trash", "清除"));
  await view.click("保存设置");
  assert.equal(view.calls.at(-1).body.shortcuts.trash, "");
  assert.equal(view.saved[0].shortcuts.trash, "");
  assert.equal(view.saved[0].shortcuts.branch, "Ctrl+B");
});

test("model connection status reflects only actual model-list responses and resets when credentials change", async (t) => {
  const view = await fixture(t);
  const status = () => view.document.querySelector('[aria-label="模型服务检查结果"]');
  assert.equal(status().dataset.state, "idle");
  assert.match(status().textContent, /尚未检查/);
  assert.equal(view.calls.filter((call) => call.url === "/api/models").length, 0);
  await view.click("保存设置并读取模型");
  assert.equal(status().dataset.state, "success");
  assert.match(status().textContent, /已读取 2 个模型/);
  assert.match(status().textContent, /回答能力需在会话中验证/);
  assert.doesNotMatch(status().textContent, /已连接|连接成功/);
  await view.set("baseUrl", "https://another.example.invalid/v1");
  assert.equal(status().dataset.state, "idle");
  assert.equal(view.document.querySelectorAll("datalist option").length, 0);
  assert.equal(view.document.querySelector('[role="status"]'), null);
  await view.click("保存设置并读取模型");
  await view.set("apiKey", "changed-key");
  assert.equal(status().dataset.state, "idle");
  assert.equal(view.document.querySelectorAll("datalist option").length, 0);
});

test("reading preview updates text and code display immediately while preserving existing user spacing", async (t) => {
  const view = await fixture(t, { initial: { lineHeight: 1.9 } });
  await view.click("阅读");
  const preview = view.document.querySelector('[aria-label="阅读实时预览"]');
  assert.equal(preview.style.lineHeight, "1.9");
  await view.set("lineHeight", 1.65);
  await view.set("fontSize", 18);
  await view.toggle("代码自动折行");
  assert.equal(preview.style.lineHeight, "1.65");
  assert.equal(preview.style.fontSize, "18px");
  assert.equal(preview.classList.contains("code-wrap"), true);
  assert.match(preview.textContent, /18 px \/ 1.65/);
  assert.match(preview.querySelector("code").textContent, /independent: true/);
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
  assert.equal(view.document.querySelector('[name="lineHeight"]').validity.stepMismatch, false);
});

test("shortcut search filters operations, shows an empty state and never saves or changes bindings", async (t) => {
  const view = await fixture(t);
  await view.click("快捷键");
  const count = () => view.document.querySelector('[aria-label="快捷键修改数量"]').textContent;
  assert.match(count(), /0 项已修改/);
  await view.set("shortcutSearch", shortcutAction("branch").label);
  assert.ok(shortcutRow(view, "branch"));
  assert.ok(view.document.querySelectorAll("[data-shortcut-action]").length < SHORTCUT_ACTIONS.length);
  await view.set("shortcutSearch", "Ctrl+Shift+B");
  assert.ok(shortcutRow(view, "branch"));
  await view.set("shortcutSearch", "no-such-shortcut-0000");
  assert.equal(view.document.querySelectorAll("[data-shortcut-action]").length, 0);
  assert.match(view.document.querySelector(".shortcut-empty").textContent, /没有匹配的快捷键/);
  await view.click("清空搜索");
  assert.equal(view.document.querySelectorAll("[data-shortcut-action]").length, SHORTCUT_ACTIONS.length);
  assert.match(count(), /0 项已修改/);
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
});

test("shortcut modification counts and reset affect only the pending draft, with recording isolated from search", async (t) => {
  const view = await fixture(t, { initial: { shortcuts: { ...DEFAULT_SHORTCUTS, branch: "Ctrl+B" } } });
  await view.click("快捷键");
  const count = () => view.document.querySelector('[aria-label="快捷键修改数量"]').textContent;
  assert.match(count(), /1 项已修改/);
  await view.click(shortcutControl(view, "trash", "清除"));
  assert.match(count(), /2 项已修改/);
  await view.click(shortcutControl(view, "branch"));
  assert.equal(view.document.querySelector('[name="shortcutSearch"]').disabled, true);
  await recordKey(view, { key: "Escape", code: "Escape" });
  assert.equal(view.document.querySelector('[name="shortcutSearch"]').disabled, false);
  assert.match(count(), /2 项已修改/);
  await view.click("恢复全部默认快捷键");
  assert.match(count(), /0 项已修改/);
  assert.equal(view.button("恢复全部默认快捷键").disabled, true);
  assert.equal(view.calls.filter((call) => call.method === "PUT").length, 0);
  await view.click("取消");
  assert.equal(view.closed(), 1);
  assert.equal(view.saved.length, 0);
});
