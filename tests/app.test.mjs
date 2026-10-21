import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { createBoard, createNode, newId, validateWorkspace, buildContext } from "../shared/core.mjs";
import { comparisonFingerprint } from "../shared/comparison.mjs";
import { createConclusion, buildRequestContext, summaryEvidenceFingerprint } from "../shared/research.mjs";

// Mount the real application, changing only its terminal createRoot expression
// in this temporary test bundle so that each case can unmount cleanly.
const bundleUrl = new URL(`../artifacts/test-app-${process.pid}.mjs`, import.meta.url);
const mainUrl = new URL("../src/main.jsx", import.meta.url);
const mainSource = await readFile(mainUrl, "utf8");
const mount = 'createRoot(document.getElementById("root")).render(<App />);';
assert.ok(mainSource.includes(mount), "The test harness must instrument the actual application mount");
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await build({
  stdin: {
    contents: mainSource.replace(mount, 'export const appRoot = createRoot(document.getElementById("root")); appRoot.render(<App />);'),
    sourcefile: "main.jsx", resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "jsx",
  },
  outfile: fileURLToPath(bundleUrl), bundle: true, platform: "browser", format: "esm", target: "es2022",
  external: ["react", "react/*", "react-dom", "react-dom/*"],
  loader: { ".css": "empty" }, logLevel: "silent",
});
after(() => rm(bundleUrl, { force: true }));

const timestamp = "2026-10-17T00:00:00.000Z";
const message = (role, content) => ({ id: newId(), role, content, createdAt: timestamp });
const summary = (title, text) => ({ title, text, updatedAt: timestamp, model: "mock-model", fingerprint: "test" });
function fixture() {
  const board = createBoard("集成测试画布");
  const first = board.nodes[0];
  first.title = "原始主干标题";
  first.messages = [
    message("user", "怎样清晰呈现数值推导？"),
    message("assistant", "**渲染加粗**，公式 $x_i^2$ 与 \\(\\frac{a}{b}\\)。\n\n" + "这里是详细讨论内容。".repeat(25) + "深层检索唯一词 hidden-evidence-731。"),
  ];
  first.summary = summary("主干：数值推导", "概括整个推导问题，明确主干的研究目标。");
  const branch = createNode(board, { parentId: first.id, title: "工程方向" });
  branch.messages = [message("user", "工程里怎样验证结果？"), message("assistant", "独立检查边界条件与数值稳定性。")];
  branch.summary = summary("分支：工程验证", "围绕边界条件进行独立验证。");
  const archived = createNode(board, { title: "旧的归档探索" });
  archived.messages = [message("user", "archive-evidence-912 归档证据"), message("assistant", "保留归档中的回答。")];
  archived.status = "archived";
  archived.archivedAt = timestamp;
  archived.summary = summary("归档：已有观点", "这条归档会话仍然可以搜索和恢复。");
  return {
    workspace: validateWorkspace({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] }),
    ids: { board: board.id, first: first.id, branch: branch.id, archived: archived.id },
    settings: {
      baseUrl: "http://127.0.0.1:11434/v1", model: "mock-model", temperature: 0.7, systemPrompt: "",
      rememberKey: false, hasApiKey: false, keyStorage: "encrypted", theme: "light", fontSize: 16,
      lineHeight: 1.8, codeWrap: false, reduceMotion: true, panelWidth: 560, sendOnEnter: true,
      showMinimap: true, autoSummary: false, summaryMaxLength: 160, maxOutputTokens: 0,
      requestTimeoutSeconds: 120, dataDirectory: "D:\\test-branch-data",
    },
  };
}

let mountedCases = 0;
async function withApp(run, options = {}) {
  const data = fixture();
  if (options.zoom != null) data.workspace.boards[0].viewport.zoom = options.zoom;
  if (options.firstSize) Object.assign(data.workspace.boards[0].nodes.find((node) => node.id === data.ids.first), options.firstSize);
  if (options.settings) Object.assign(data.settings, options.settings);
  options.mutateFixture?.(data);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://app.local" });
  const keys = ["window", "document", "navigator", "localStorage", "ResizeObserver", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [];
  const bridgeCalls = [];
  const scrollCalls = [];
  let savedWorkspace = structuredClone(data.workspace);
  let savedSettings = structuredClone(data.settings);
  let closeHandler;
  let commandHandler;
  const bridge = {
    version: "1.2.0-test", appReady() {},
    getWindowState: async () => ({ maximized: false }),
    onWindowState: () => () => {},
    onCommand(callback) { commandHandler = callback; return () => { if (commandHandler === callback) commandHandler = null; }; },
    onCloseRequested(callback) { closeHandler = callback; return () => { if (closeHandler === callback) closeHandler = null; }; },
    closeReady: (saved) => bridgeCalls.push(["closeReady", saved]), windowAction() {},
    copyText: async (text) => bridgeCalls.push(["copyText", text]),
    openDataDirectory: async () => bridgeCalls.push(["openDataDirectory"]),
    chooseDataDirectory: async () => { bridgeCalls.push(["chooseDataDirectory"]); return { directory: "D:\\test-new-directory", hasWorkspace: false }; },
  };
  Object.assign(bridge, options.bridge);
  class ResizeObserverMock {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.callback([{ target, contentRect: { width: 1440, height: 900 } }]); }
    disconnect() {}
  }
  const fetchMock = async (url, requestOptions = {}) => {
    const method = requestOptions.method || "GET";
    const payload = requestOptions.body ? JSON.parse(requestOptions.body) : null;
    requests.push({ url, method, payload });
    if (url === "/api/workspace" && method === "GET") return Response.json(structuredClone(savedWorkspace));
    if (url === "/api/workspace" && method === "PUT") {
      assert.equal(payload.revision, savedWorkspace.revision, "Workspace writes must use the latest revision");
      savedWorkspace = validateWorkspace({ ...payload, revision: payload.revision + 1 });
      return Response.json({ revision: savedWorkspace.revision });
    }
    if (url === "/api/settings" && method === "GET") return Response.json(structuredClone(savedSettings));
    if (url === "/api/settings" && method === "PUT") {
      savedSettings = { ...savedSettings, ...payload };
      return Response.json(structuredClone(savedSettings));
    }
    if (url === "/api/summarize" && options.allowSummaries) {
      const count = requests.filter((request) => request.url === "/api/summarize").length;
      return Response.json({ boardId: payload.boardId, nodeId: payload.nodeId,
        summary: summary(`模型摘要 ${count}`, "集成测试模型返回的当前会话总结。") });
    }
    if (url === "/api/compare" && options.allowComparisons) {
      const board = payload.workspace.boards.find((entry) => entry.id === payload.boardId);
      const sources = payload.nodeIds.map((id) => board.nodes.find((node) => node.id === id));
      const comparison = {
        title: "比较后的研究结论", sourceNodeIds: [...payload.nodeIds], fingerprint: comparisonFingerprint(board, payload.nodeIds),
        createdAt: timestamp, model: "mock-comparison-model",
        items: [
          { id: "evidence-agreement", text: "需把数值推导与工程边界检查结合。", category: "agreement", verified: true, adopted: true,
            citations: [{ nodeId: sources[0].id, messageId: sources[0].messages[0].id, quote: sources[0].messages[0].content }] },
          { id: "evidence-open", text: "仍需验证不同边界条件下的表现。", category: "open", verified: true, adopted: true,
            citations: [{ nodeId: sources[1].id, messageId: sources[1].messages[1].id, quote: sources[1].messages[1].content }] },
        ],
      };
      return Response.json({ boardId: payload.boardId, nodeIds: [...payload.nodeIds], comparison });
    }
    if (url === "/api/chat" && options.allowChat) return Response.json({ choices: [{ message: { content: "模拟模型回答：已按所选上下文处理当前问题。" } }] });
    throw new Error(`This integration test forbids real model/network access: ${method} ${url}`);
  };
  let appRoot;
  try {
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.HTMLElement.prototype.scrollIntoView = function (options) {
      scrollCalls.push({ messageId: this.closest("[data-message-id]")?.dataset.messageId, className: this.className, options });
    };
    const capturedPointers = new WeakMap();
    dom.window.HTMLElement.prototype.setPointerCapture = function (id) { capturedPointers.set(this, id); };
    dom.window.HTMLElement.prototype.hasPointerCapture = function (id) { return capturedPointers.get(this) === id; };
    dom.window.HTMLElement.prototype.releasePointerCapture = function (id) { if (capturedPointers.get(this) === id) capturedPointers.delete(this); };
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 });
    Object.defineProperty(dom.window, "innerWidth", { value: 1440 });
    dom.window.branchDesktop = bridge;
    for (const [key, value] of [
      ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
      ["localStorage", dom.window.localStorage], ["ResizeObserver", ResizeObserverMock],
      ["fetch", fetchMock], ["IS_REACT_ACT_ENVIRONMENT", true],
    ]) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    await act(async () => { ({ appRoot } = await import(`${bundleUrl.href}?case=${mountedCases++}`)); });
    const document = dom.window.document;
    assert.ok(document.querySelector(".application-shell"), document.body.textContent);
    const findButton = (text, scope = document) => [...scope.querySelectorAll("button")].find((button) => {
      const label = button.cloneNode(true);
      label.querySelectorAll("kbd").forEach((key) => key.remove());
      return label.textContent.trim() === text;
    });
    await run({
      document, window: dom.window, requests, bridgeCalls, scrollCalls, ids: data.ids, findButton,
      get savedWorkspace() { return savedWorkspace; }, get savedSettings() { return savedSettings; },
      async click(target) {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        assert.ok(element, `Missing clickable element: ${target}`);
        await act(async () => element.click());
      },
      async type(target, value) {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        assert.ok(element, `Missing input: ${target}`);
        await act(async () => {
          const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype
            : element.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
          element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
        });
      },
      async key(target, key, modifiers = {}) {
        const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
        await act(async () => target.dispatchEvent(event));
        return event;
      },
      async focus(target) {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        assert.ok(element, `Missing focus target: ${target}`);
        await act(async () => element.focus());
        assert.equal(document.activeElement, element);
      },
      async scrollConversation(offset) {
        const scroll=document.querySelector('.chat-scroll');
        assert.ok(scroll,'A conversation must be open before scrolling');
        Object.defineProperties(scroll,{scrollHeight:{value:3000,configurable:true},clientHeight:{value:500,configurable:true}});
        await act(async()=>{scroll.scrollTop=offset;scroll.dispatchEvent(new dom.window.Event('scroll',{bubbles:true}));});
      },
      async contextMenu(target) {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        assert.ok(element, `Missing context-menu target: ${target}`);
        await act(async () => element.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })));
      },
      async conversationAction(action) {
        const more=document.querySelector('[aria-label="会话更多操作"]');
        assert.ok(more,'The conversation overflow menu must be available');
        await act(async()=>{more.focus();more.click();});
        const button=document.querySelector(`.context-menu [data-action="${action}"]`);
        assert.ok(button,`Missing conversation action: ${action}`);
        await act(async()=>{button.focus();button.click();});
      },
      async nativeCommand(command) {
        assert.equal(typeof commandHandler, "function");
        await act(async () => commandHandler(command));
      },
      async pointer(target, type, x, y) {
        await act(async () => {
          const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 });
          Object.defineProperty(event, "pointerId", { value: 1 });
          target.dispatchEvent(event);
        });
      },
      async flushSave() {
        assert.equal(typeof closeHandler, "function");
        await act(async () => closeHandler());
      },
      async waitFor(predicate, label = "application state") {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (predicate()) return;
          await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
        }
        assert.ok(predicate(), `Timed out waiting for ${label}`);
      },
    });
    if (!options.allowChat) assert.equal(requests.filter((request) => request.url === "/api/chat").length, 0);
    if (!options.allowComparisons) assert.equal(requests.filter((request) => request.url === "/api/compare").length, 0);
    if (!options.allowSummaries) assert.equal(requests.filter((request) => request.url === "/api/summarize").length, 0);
  } finally {
    if (appRoot) await act(async () => appRoot.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("the real application displays summary-first cards and renders bold and formulas after opening a conversation", async () => {
  await withApp(async (h) => {
    const card = h.document.querySelector(`[aria-label="打开对话：原始主干标题"]`);
    assert.equal(card.querySelector("h3").textContent, "主干：数值推导");
    assert.equal(card.querySelector(".node-summary").textContent, "概括整个推导问题，明确主干的研究目标。");
    assert.match(card.querySelector(".node-excerpts").textContent, /怎样清晰呈现数值推导/);
    assert.match(card.querySelector(".node-excerpts").textContent, /渲染加粗/);
    assert.ok(card.innerHTML.indexOf("node-summary") < card.innerHTML.indexOf("node-excerpts"));
    await h.click(card);
    assert.equal(h.document.querySelector(".message-content strong").textContent, "渲染加粗");
    assert.equal(h.document.querySelectorAll(".message-content .katex").length, 2);
    assert.equal(h.document.querySelector(".message-content").style.getPropertyValue("--message-font-size"), "16px");
    assert.equal(h.document.querySelector("textarea[aria-label='输入消息']").disabled, false);
  });
});

test("conversation width responds to keyboard resizing, persists the width, and expands for reading", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    const separator = h.document.querySelector('[role="separator"][aria-label="调整会话宽度"]');
    assert.equal(separator.getAttribute("aria-valuenow"), "560");
    await h.key(separator, "ArrowLeft");
    assert.equal(separator.getAttribute("aria-valuenow"), "600");
    assert.equal(h.savedSettings.panelWidth, 600);
    assert.equal(h.document.querySelector(".application-shell").style.getPropertyValue("--chat-panel-width"), "600px");
    await h.click('[aria-label="展开阅读"]');
    assert.ok(h.document.querySelector(".chat-panel").classList.contains("expanded"));
    assert.equal(h.document.querySelector('[role="separator"]'), null);
    await h.click('[aria-label="恢复面板宽度"]');
    assert.equal(h.document.querySelector('[role="separator"]').getAttribute("aria-valuenow"), "600");
  });
});

test("keyboard resizing changes and persists only the chosen card's dimensions", async () => {
  await withApp(async (h) => {
    const first = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    const second = h.document.querySelector('[aria-label="打开对话：工程方向"]');
    const handle = h.document.querySelector('[aria-label="调整卡片大小：原始主干标题"]');
    assert.ok(handle, "Each canvas card needs its own accessible resize handle");
    assert.equal(first.style.width, "320px");
    assert.equal(first.style.height, "248px");
    const unchanged = { width: second.style.width, height: second.style.height, left: second.style.left, top: second.style.top };
    await h.key(handle, "ArrowRight");
    await h.key(handle, "ArrowDown");
    assert.equal(first.style.width, "340px");
    assert.equal(first.style.height, "268px");
    assert.deepEqual({ width: second.style.width, height: second.style.height, left: second.style.left, top: second.style.top }, unchanged);
    assert.equal(h.document.querySelector(".chat-panel"), null);
    await h.flushSave();
    const nodes = h.savedWorkspace.boards[0].nodes;
    assert.equal(nodes.find((node) => node.id === h.ids.first).width, 340);
    assert.equal(nodes.find((node) => node.id === h.ids.first).height, 268);
    assert.equal(nodes.find((node) => node.id === h.ids.branch).width, 320);
    assert.equal(nodes.find((node) => node.id === h.ids.branch).height, 248);
  });
});

test("card resize keyboard controls enforce both dimension limits and Home restores the defaults", async () => {
  await withApp(async (h) => {
    const first = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    const handle = h.document.querySelector('[aria-label="调整卡片大小：原始主干标题"]');
    assert.ok(handle);
    for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown"]) await h.key(handle, key);
    assert.equal(first.style.width, "960px");
    assert.equal(first.style.height, "800px");
    await h.key(handle, "Home");
    assert.equal(first.style.width, "320px");
    assert.equal(first.style.height, "248px");
    for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowUp", "ArrowUp", "ArrowUp"]) await h.key(handle, key);
    assert.equal(first.style.width, "260px");
    assert.equal(first.style.height, "220px");
    await h.key(handle, "Home");
    await h.flushSave();
    const saved = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.first);
    assert.equal(saved.width, 320);
    assert.equal(saved.height, 248);
    assert.equal(h.document.querySelector(".chat-panel"), null);
  }, { firstSize: { width: 940, height: 780 } });
});

test("pointer resizing divides screen movement by zoom without opening or moving either card", async () => {
  await withApp(async (h) => {
    const first = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    const second = h.document.querySelector('[aria-label="打开对话：工程方向"]');
    const handle = h.document.querySelector('[aria-label="调整卡片大小：原始主干标题"]');
    assert.ok(handle);
    assert.match(h.document.querySelector(".world").style.transform, /scale\(0\.5\)/);
    const originalPosition = { left: first.style.left, top: first.style.top };
    const otherCard = { width: second.style.width, height: second.style.height, left: second.style.left, top: second.style.top };
    await h.pointer(handle, "pointerdown", 100, 100);
    await h.pointer(handle, "pointermove", 140, 130);
    await h.pointer(handle, "pointerup", 140, 130);
    await h.click(handle); // The click following a real pointer release must not open the conversation.
    assert.equal(first.style.width, "400px");
    assert.equal(first.style.height, "308px");
    assert.deepEqual({ left: first.style.left, top: first.style.top }, originalPosition);
    assert.deepEqual({ width: second.style.width, height: second.style.height, left: second.style.left, top: second.style.top }, otherCard);
    assert.equal(h.document.querySelector(".chat-panel"), null);
    await h.flushSave();
    const saved = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.first);
    assert.equal(saved.width, 400);
    assert.equal(saved.height, 308);
    assert.equal(`${saved.x}px`, originalPosition.left);
    assert.equal(`${saved.y}px`, originalPosition.top);
    assert.equal(h.savedWorkspace.boards[0].viewport.zoom, 0.5);
  }, { zoom: 0.5 });
});

test("Ctrl+N creates a conversation while Ctrl+Shift+N creates a separate named board", async () => {
  await withApp(async (h) => {
    const original = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    await h.focus(original);
    await h.key(original, "n", { ctrlKey: true });
    assert.equal(h.document.querySelectorAll(".node-card").length, 3);
    assert.equal(h.document.querySelector('[role="dialog"]'), null);
    assert.match(h.document.querySelector(".chat-title").textContent, /新的对话/);
    await h.flushSave();
    assert.equal(h.savedWorkspace.boards.length, 1);
    assert.equal(h.savedWorkspace.boards[0].nodes.length, 4);
    await h.focus(original);
    await h.key(original, "n", { ctrlKey: true, shiftKey: true });
    assert.ok(h.document.querySelector('[role="dialog"][aria-label="新建画布"]'));
    await h.type('input[aria-label="名称"]', "快捷键创建的画布");
    await h.click(h.findButton("确定"));
    await h.flushSave();
    assert.equal(h.savedWorkspace.boards.length, 2);
    assert.equal(h.savedWorkspace.boards.find((board) => board.id === h.savedWorkspace.activeBoardId).title, "快捷键创建的画布");
  });
});

test("branch shortcuts target the focused card ahead of the currently open conversation", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    const focused = h.document.querySelector('[aria-label="打开对话：工程方向"]');
    await h.focus(focused);
    await h.key(focused, "b", { ctrlKey: true, shiftKey: true });
    await h.flushSave();
    const created = h.savedWorkspace.boards[0].nodes.find((node) => !Object.values(h.ids).includes(node.id));
    assert.ok(created);
    assert.equal(created.parentId, h.ids.branch);
    assert.match(JSON.stringify(created.source.context), /工程里怎样验证结果/);
  });
});

test("fixed tree arrows navigate focus and Ctrl+Shift+E toggles the focused root rather than another open conversation", async () => {
  await withApp(async (h) => {
    await h.click(h.findButton("归档", h.document.querySelector(".management-shortcuts")));
    await h.click(h.findButton("恢复", h.document.querySelector(".management-entry")));
    assert.match(h.document.querySelector(".chat-title").textContent, /旧的归档探索/);
    const rootRow = h.document.querySelector(`.tree-row[data-node-id="${h.ids.first}"]`);
    const rootButton = rootRow.querySelector(".tree-node");
    let childButton = h.document.querySelector(`.tree-row[data-node-id="${h.ids.branch}"] .tree-node`);
    await h.focus(rootButton);
    await h.key(rootButton, "ArrowDown");
    assert.equal(h.document.activeElement, childButton);
    await h.key(childButton, "ArrowUp");
    assert.equal(h.document.activeElement, rootButton);
    await h.key(rootButton, "ArrowRight");
    assert.equal(h.document.activeElement, childButton);
    await h.key(childButton, "ArrowLeft");
    assert.equal(h.document.activeElement, rootButton);
    await h.key(rootButton, "ArrowLeft");
    assert.equal(rootRow.querySelector(".tree-toggle").getAttribute("aria-expanded"), "false");
    await h.key(rootButton, "ArrowRight");
    assert.equal(rootRow.querySelector(".tree-toggle").getAttribute("aria-expanded"), "true");

    await h.key(rootButton, "e", { ctrlKey: true, shiftKey: true });
    assert.equal(rootRow.querySelector(".tree-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(h.document.querySelector(`.tree-row[data-node-id="${h.ids.branch}"]`), null);
    assert.equal(h.document.querySelector('[aria-label="打开对话：工程方向"]'), null);
    assert.match(h.document.querySelector(".chat-title").textContent, /旧的归档探索/);
    assert.deepEqual(JSON.parse(h.window.localStorage.getItem("branch-local:collapsed"))[h.ids.board], [h.ids.first]);
    await h.key(rootButton, "e", { ctrlKey: true, shiftKey: true });
    childButton = h.document.querySelector(`.tree-row[data-node-id="${h.ids.branch}"] .tree-node`);
    assert.ok(childButton);
    assert.ok(h.document.querySelector('[aria-label="打开对话：工程方向"]'));
    assert.match(h.document.querySelector(".chat-title").textContent, /旧的归档探索/);
  });
});

test("branch shortcuts on an early message inherit only through that message while an open menu ignores the old message anchor", async () => {
  await withApp(async (h) => {
    const parent = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.first);
    const parentHistory = structuredClone(parent.messages);
    const card = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    await h.click(card);
    let anchor = h.document.querySelector(".message.user .branch-action");
    assert.equal(anchor.closest("[data-message-id]").dataset.messageId, parentHistory[0].id);
    await h.focus(anchor);
    await h.key(anchor, "b", { ctrlKey: true, shiftKey: true });
    await h.flushSave();
    const earlyBranch = h.savedWorkspace.boards[0].nodes.find((node) => !Object.values(h.ids).includes(node.id));
    assert.equal(earlyBranch.parentId, h.ids.first);
    assert.equal(earlyBranch.source.messageId, parentHistory[0].id);
    assert.deepEqual(earlyBranch.source.context.map(({ role, content }) => ({ role, content })),
      parentHistory.slice(0, 1).map(({ role, content }) => ({ role, content })));
    assert.doesNotMatch(JSON.stringify(earlyBranch.source.context), /渲染加粗|hidden-evidence-731/);

    await h.click(card);
    anchor = h.document.querySelector(".message.user .branch-action");
    await h.focus(anchor);
    await h.contextMenu(card);
    await h.key(anchor, "b", { ctrlKey: true, shiftKey: true });
    await h.flushSave();
    const fullBranch = h.savedWorkspace.boards[0].nodes.find((node) =>
      !Object.values(h.ids).includes(node.id) && node.id !== earlyBranch.id);
    assert.equal(fullBranch.parentId, h.ids.first);
    assert.equal(fullBranch.source.messageId, parentHistory.at(-1).id);
    assert.deepEqual(fullBranch.source.context.map(({ role, content }) => ({ role, content })),
      parentHistory.map(({ role, content }) => ({ role, content })));
  });
});

test("archive shortcuts use the focused tree entry and require confirmation before changing it", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    const treeTarget = h.findButton("分支：工程验证", h.document.querySelector(".tree-navigator"));
    await h.focus(treeTarget);
    await h.key(treeTarget, "a", { ctrlKey: true, shiftKey: true });
    const confirmation = h.document.querySelector('[role="dialog"][aria-label="归档这条分支？"]');
    assert.ok(confirmation);
    assert.match(confirmation.querySelector(".dialog-description").textContent, /工程方向/);
    assert.equal(h.document.activeElement, h.findButton("取消", confirmation));
    const confirmButton = h.findButton("归档分支", confirmation);
    await h.focus(confirmButton);
    await h.key(confirmButton, "Tab");
    const firstFocusable = confirmation.querySelector("button");
    assert.equal(h.document.activeElement, firstFocusable);
    await h.key(firstFocusable, "Tab", { shiftKey: true });
    assert.equal(h.document.activeElement, confirmButton);
    assert.ok(h.document.querySelector('[aria-label="打开对话：工程方向"]'));
    await h.click(h.findButton("归档分支", confirmation));
    await h.flushSave();
    const nodes = h.savedWorkspace.boards[0].nodes;
    assert.equal(nodes.find((node) => node.id === h.ids.branch).status, "archived");
    assert.equal(nodes.find((node) => node.id === h.ids.first).status, "active");
  });
});

test("the right-click target takes priority over focused and open cards, and Ctrl+Shift+Delete only opens trash", async () => {
  await withApp(async (h) => {
    const first = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    const other = h.document.querySelector('[aria-label="打开对话：工程方向"]');
    await h.click(first);
    await h.focus(first);
    await h.contextMenu(other);
    assert.ok(h.document.querySelector('[role="menu"]'));
    await h.key(first, "Delete");
    const confirmation = h.document.querySelector('[role="dialog"][aria-label="删除这条分支？"]');
    assert.ok(confirmation);
    assert.match(confirmation.querySelector(".dialog-description").textContent, /工程方向/);
    assert.ok(h.document.querySelector('[aria-label="打开对话：工程方向"]'));
    await h.click(h.findButton("移入回收站", confirmation));
    await h.flushSave();
    const nodes = h.savedWorkspace.boards[0].nodes;
    assert.equal(nodes.find((node) => node.id === h.ids.first).status, "active");
    assert.equal(nodes.find((node) => node.id === h.ids.branch).status, "trashed");
    await h.focus(first);
    await h.key(first, "Delete", { ctrlKey: true, shiftKey: true });
    assert.ok(h.document.querySelector('[role="dialog"][aria-label="回收站"]'));
    assert.equal(h.document.querySelector('[role="dialog"][aria-label="永久删除？"]'), null);
    assert.ok(h.savedWorkspace.boards[0].nodes.some((node) => node.id === h.ids.branch));
  });
});

test("board-menu F2 and Delete operate on the board instead of an open or focused conversation", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    const card = h.document.querySelector('[aria-label="打开对话：工程方向"]');
    await h.focus(card);
    await h.click('[aria-label="画布菜单：集成测试画布"]');
    await h.key(card, "F2");
    assert.ok(h.document.querySelector('[role="dialog"][aria-label="重命名画布"]'));
    await h.type('input[aria-label="名称"]', "快捷键改名画布");
    await h.click(h.findButton("确定"));
    await h.flushSave();
    assert.equal(h.savedWorkspace.boards[0].title, "快捷键改名画布");
    assert.equal(h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.branch).title, "工程方向");
    await h.focus(card);
    await h.click('[aria-label="画布菜单：快捷键改名画布"]');
    await h.key(card, "Delete");
    const confirmation = h.document.querySelector('[role="dialog"][aria-label="删除这张画布？"]');
    assert.ok(confirmation);
    assert.equal(h.savedWorkspace.boards[0].status, "active");
    await h.click(h.findButton("移入回收站", confirmation));
    await h.flushSave();
    const removed = h.savedWorkspace.boards.find((board) => board.id === h.ids.board);
    assert.equal(removed.status, "trashed");
    assert.equal(removed.nodes.length, 3);
    assert.ok(h.savedWorkspace.boards.some((board) => board.status === "active"));
  });
});

test("typing, IME composition, repeat keys, and open dialogs suppress destructive or contextual shortcuts", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    const composer = h.document.querySelector('textarea[aria-label="输入消息"]');
    await h.type(composer, "正在输入的文字");
    await h.focus(composer);
    for (const [key, modifiers] of [["Delete", {}], ["F2", {}], ["a", { ctrlKey: true, shiftKey: true }], ["b", { ctrlKey: true, shiftKey: true }]]) {
      await h.key(composer, key, modifiers);
    }
    await h.nativeCommand("trash");
    assert.equal(h.document.querySelector('[role="dialog"]'), null);
    assert.equal(h.document.querySelectorAll(".node-card").length, 2);
    assert.equal(composer.value, "正在输入的文字");
    assert.equal((await h.key(composer, "z", { ctrlKey: true })).defaultPrevented, false, "Ctrl+Z must remain available for native text undo");

    const card = h.document.querySelector('[aria-label="打开对话：工程方向"]');
    await h.focus(card);
    for (const modifiers of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
      await h.key(card, "Delete", modifiers);
      await h.key(card, "b", { ctrlKey: true, shiftKey: true, ...modifiers });
      await h.key(card, "Escape", modifiers);
    }
    assert.equal(h.document.querySelector('[role="dialog"]'), null);
    assert.equal(h.document.querySelectorAll(".node-card").length, 2);
    assert.ok(h.document.querySelector(".chat-panel"), "IME or repeated Escape must not close the current conversation");
    await h.nativeCommand("trash");
    const nativeConfirmation = h.document.querySelector('[role="dialog"][aria-label="删除这条分支？"]');
    assert.ok(nativeConfirmation, "A native command must use the same real action dispatcher");
    assert.match(nativeConfirmation.querySelector(".dialog-description").textContent, /工程方向/);
    await h.click(h.findButton("取消", nativeConfirmation));

    await h.click(".settings-entry");
    await h.key(h.document.body, "Escape", { isComposing: true });
    assert.equal(h.document.querySelector('[role="dialog"][aria-label="应用设置"]').closest(".modal-shade").classList.contains("presence-exit"), false);
    for (const [key, modifiers] of [["Delete", {}], ["n", { ctrlKey: true }], ["n", { ctrlKey: true, shiftKey: true }], ["k", { ctrlKey: true }]]) {
      await h.key(h.document.body, key, modifiers);
    }
    await h.nativeCommand("new-board");
    assert.equal(h.document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(h.document.querySelector('[role="dialog"][aria-label="应用设置"]'));
    assert.equal(h.document.querySelectorAll(".node-card").length, 2);
  });
});

test("recorded shortcut changes update execution and menu hints, and clearing a binding disables its old keys", async () => {
  await withApp(async (h) => {
    const first = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    const target = h.document.querySelector('[aria-label="打开对话：工程方向"]');
    await h.contextMenu(target);
    assert.equal(h.document.querySelector('[data-action="branch"] kbd').textContent.replace(/\s/g, ""), "Ctrl+Shift+B");
    await h.key(first, "Escape");
    await h.click(".settings-entry");
    await h.click(h.findButton("快捷键"));
    const record = h.document.querySelector('[data-shortcut-action="branch"] .shortcut-binding');
    await h.click(record);
    await h.key(record, "y", { code: "KeyY", ctrlKey: true, shiftKey: true });
    assert.equal(record.getAttribute("aria-pressed"), "false");
    assert.equal(h.document.querySelectorAll(".node-card").length, 2, "Recording must not execute the assigned shortcut");
    await h.click(h.findButton("保存设置"));
    assert.equal(h.savedSettings.shortcuts.branch, "Ctrl+Shift+Y");
    await h.focus(target);
    await h.key(target, "b", { ctrlKey: true, shiftKey: true });
    assert.equal(h.document.querySelectorAll(".node-card").length, 2, "The previous shortcut must no longer execute");
    await h.contextMenu(target);
    assert.equal(h.document.querySelector('[data-action="branch"] kbd').textContent.replace(/\s/g, ""), "Ctrl+Shift+Y");
    await h.key(first, "y", { code: "KeyY", ctrlKey: true, shiftKey: true });
    assert.equal(h.document.querySelectorAll(".node-card").length, 3);
    await h.flushSave();
    const created = h.savedWorkspace.boards[0].nodes.find((node) => !Object.values(h.ids).includes(node.id));
    assert.equal(created.parentId, h.ids.branch);

    await h.click(".settings-entry");
    await h.click(h.findButton("快捷键"));
    await h.click(h.document.querySelector('[aria-label="清除快捷键：从当前会话创建分支"]'));
    await h.click(h.findButton("保存设置"));
    assert.equal(h.savedSettings.shortcuts.branch, "");
    await h.focus(target);
    await h.key(target, "y", { code: "KeyY", ctrlKey: true, shiftKey: true });
    await h.key(target, "b", { ctrlKey: true, shiftKey: true });
    assert.equal(h.document.querySelectorAll(".node-card").length, 3);
    await h.contextMenu(target);
    assert.equal(h.document.querySelector('[data-action="branch"] kbd'), null);
  });
});

test("rebinding a global search command to Delete or Ctrl+Z preserves text editing while still working on the canvas", async () => {
  for (const configuration of [
    { shortcuts: { trash: "", search: "Delete" }, key: "Delete", modifiers: { code: "Delete" } },
    { shortcuts: { "undo-remove": "", search: "Ctrl+Z" }, key: "z", modifiers: { code: "KeyZ", ctrlKey: true } },
  ]) await withApp(async (h) => {
    const card = h.document.querySelector('[aria-label="打开对话：原始主干标题"]');
    await h.click(card);
    const composer = h.document.querySelector('textarea[aria-label="输入消息"]');
    await h.type(composer, "输入框保留正常删除与撤销");
    await h.focus(composer);
    const typingEvent = await h.key(composer, configuration.key, configuration.modifiers);
    assert.equal(typingEvent.defaultPrevented, false, `${configuration.shortcuts.search} must retain native editing in an input`);
    assert.equal(h.document.querySelector('[role="dialog"][aria-label="搜索所有画布"]'), null);
    assert.equal(h.document.activeElement, composer);
    await h.focus(card);
    const canvasEvent = await h.key(card, configuration.key, configuration.modifiers);
    assert.equal(canvasEvent.defaultPrevented, true);
    assert.ok(h.document.querySelector('[role="dialog"][aria-label="搜索所有画布"]'));
  }, { settings: { shortcuts: configuration.shortcuts } });
});

test("full-text search finds text beyond the card excerpt and opens archived results in read-only mode", async () => {
  await withApp(async (h) => {
    assert.doesNotMatch(h.document.querySelector(".node-excerpts").textContent, /hidden-evidence-731/);
    await h.click('[aria-label="搜索所有画布"]');
    await h.type('[aria-label="搜索所有画布的标题和消息"]', "hidden-evidence-731");
    // The child inherited this full answer, so both complete conversation
    // contexts must match even though neither card excerpt contains the word.
    assert.equal(h.document.querySelectorAll(".global-results button").length, 2);
    assert.match(h.document.querySelector(".result-excerpt").textContent, /hidden-evidence-731/);
    await h.type('[aria-label="搜索所有画布的标题和消息"]', "archive-evidence-912");
    assert.equal(h.document.querySelectorAll(".global-results button").length, 1);
    assert.match(h.document.querySelector(".global-results strong").textContent, /已归档/);
    await h.click(".global-results button");
    assert.equal(h.document.querySelector("textarea[aria-label='输入消息']").disabled, true);
    await h.click('[aria-label="会话更多操作"]');
    assert.equal(h.document.querySelector('.context-menu [data-action="merge"]').disabled, true);
    assert.equal(h.document.querySelector('.context-menu [data-action="archive"]').disabled, true);
    await h.key(h.document.body,'Escape');
    assert.equal(h.document.querySelector(".branch-action").disabled, true);
    assert.match(h.document.querySelector(".read-only-note").textContent, /已归档/);
    await h.click(h.findButton("恢复对话"));
    assert.equal(h.document.querySelector("textarea[aria-label='输入消息']").disabled, false);
    await h.flushSave();
    const restored = h.savedWorkspace.boards[0].nodes.find((n) => n.id === h.ids.archived);
    assert.equal(restored.status, "active");
  });
});

test("merge selection creates a new conversation with both histories while preserving the original branches", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.conversationAction('merge');
    const choices = [...h.document.querySelectorAll(".merge-choices label")];
    assert.equal(choices.length, 2);
    assert.equal(h.findButton("新建合并会话").disabled, true);
    await h.click(choices[1].querySelector("input"));
    assert.equal(h.findButton("新建合并会话").disabled, false);
    await h.click(h.findButton("新建合并会话"));
    assert.equal(h.document.querySelector(".merge-choices"), null);
    assert.equal(h.document.querySelectorAll(".node-card").length, 3);
    assert.match(h.document.querySelector(".chat-title").textContent, /合并/);
    assert.match(h.document.querySelector("textarea[aria-label='输入消息']").value, /综合这些分支/);
    await h.flushSave();
    const board = h.savedWorkspace.boards[0];
    const merged = board.nodes.find((n) => n.mergeParents.length);
    assert.equal(merged.parentId, h.ids.first);
    assert.deepEqual(merged.mergeParents, [h.ids.branch]);
    assert.match(JSON.stringify(merged.source.context), /数值推导/);
    assert.match(JSON.stringify(buildContext(board, merged.id)), /工程里怎样验证结果/);
    const primaryContext = buildContext(board, h.ids.first);
    assert.deepEqual(buildContext(board, merged.id).slice(0, primaryContext.length), primaryContext);
    assert.equal(board.nodes.find((n) => n.id === h.ids.first).messages.length, 2);
    assert.equal(board.nodes.find((n) => n.id === h.ids.branch).messages.length, 2);
  });
});

test("global search exposes active results to assistive technology and opens them with arrow keys and Enter", async()=>{
  await withApp(async(h)=>{
    await h.click('[aria-label="搜索所有画布"]');
    await h.type('[aria-label="搜索所有画布的标题和消息"]','hidden-evidence-731');
    const input=h.document.querySelector('[aria-label="搜索所有画布的标题和消息"]');
    const list=h.document.querySelector('.global-results[role="listbox"]');
    assert.ok(list);
    const options=[...list.querySelectorAll('[role="option"]')];
    assert.equal(options.length,2);
    assert.deepEqual(options.map((option)=>option.id),['search-result-0','search-result-1']);
    assert.equal(input.getAttribute('aria-activedescendant'),'search-result-0');
    assert.equal(options[0].getAttribute('aria-selected'),'true');
    await h.key(input,'ArrowDown');
    assert.equal(input.getAttribute('aria-activedescendant'),'search-result-1');
    assert.equal(options[0].getAttribute('aria-selected'),'false');
    assert.equal(options[1].getAttribute('aria-selected'),'true');
    await h.key(input,'ArrowUp');
    assert.equal(input.getAttribute('aria-activedescendant'),'search-result-0');
    await h.key(input,'ArrowDown');
    await h.key(input,'Enter');
    assert.equal(h.document.querySelector('[role="dialog"][aria-label="搜索所有画布"]'),null);
    assert.match(h.document.querySelector('.chat-title').textContent,/工程方向/);
    await h.click('[aria-label="搜索所有画布"]');
    await h.type('[aria-label="搜索所有画布的标题和消息"]','there-are-no-results-zz731');
    const emptyInput=h.document.querySelector('[aria-label="搜索所有画布的标题和消息"]');
    assert.equal(emptyInput.getAttribute('aria-activedescendant'),null);
    await h.key(emptyInput,'Enter');
    assert.ok(h.document.querySelector('[role="dialog"][aria-label="搜索所有画布"]'));
  });
});

test("workspace view controls switch canvas, split, and reading while retaining the previously opened conversation", async()=>{
  await withApp(async(h)=>{
    const switcher=h.document.querySelector('[aria-label="工作区视图"]');
    assert.ok(switcher);
    const canvas=h.findButton('画布',switcher),split=h.findButton('分屏',switcher),reading=h.findButton('阅读',switcher);
    assert.ok(canvas&&split&&reading);
    assert.equal(canvas.getAttribute('aria-pressed'),'true');
    await h.click('[aria-label="打开对话：工程方向"]');
    assert.equal(split.getAttribute('aria-pressed'),'true');
    assert.ok(h.document.querySelector('.chat-panel'));
    await h.click(reading);
    assert.equal(reading.getAttribute('aria-pressed'),'true');
    assert.ok(h.document.querySelector('.chat-panel.expanded'));
    await h.click(canvas);
    assert.equal(canvas.getAttribute('aria-pressed'),'true');
    await h.waitFor(()=>!h.document.querySelector('.chat-panel'),'canvas view finishes closing the reading panel');
    await h.click(split);
    assert.equal(split.getAttribute('aria-pressed'),'true');
    assert.ok(h.document.querySelector('.chat-panel:not(.expanded)'));
    assert.match(h.document.querySelector('.chat-title').textContent,/工程方向/);
    assert.equal(h.savedSettings.panelWidth,560);
  });
});

test("conversation switches restore reading offsets and a source jump can return to the previous conversation and offset", async()=>{
  await withApp(async(h)=>{
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.scrollConversation(172);
    await h.click('[aria-label="打开对话：工程方向"]');
    await h.scrollConversation(88);
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.waitFor(()=>h.document.querySelector('.chat-scroll')?.scrollTop===172,'root reading offset restored');
    await h.click('[aria-label="打开对话：工程方向"]');
    await h.waitFor(()=>h.document.querySelector('.chat-scroll')?.scrollTop===88,'branch reading offset restored');
    await h.click(h.findButton('定位父对话中的来源'));
    assert.match(h.document.querySelector('.chat-title').textContent,/原始主干标题/);
    assert.ok(h.document.querySelector('.branch-anchor-focus'));
    const back=h.document.querySelector('[aria-label="返回跳转前的会话"]');
    assert.ok(back);
    await h.scrollConversation(34);
    await h.click(back);
    assert.match(h.document.querySelector('.chat-title').textContent,/工程方向/);
    await h.waitFor(()=>h.document.querySelector('.chat-scroll')?.scrollTop===88,'return restores pre-jump reading offset');
  });
});

test("switching from a long conversation to a short one cannot overwrite the long conversation's saved offset after DOM clamping", async()=>{
  await withApp(async(h)=>{
    const rootMessageId=h.savedWorkspace.boards[0].nodes.find((node)=>node.id===h.ids.first).messages.at(-1).id;
    const positions=new WeakMap();
    // Model Chromium's scroll clamping when content becomes shorter. A cleanup
    // that reads a reused panel after its contents changed would incorrectly
    // save zero as the departing long conversation's reading position.
    Object.defineProperties(h.window.HTMLElement.prototype,{
      scrollHeight:{configurable:true,get(){return this.classList.contains('chat-scroll')&&this.querySelector(`[data-message-id="${rootMessageId}"]`)?3000:180;}},
      clientHeight:{configurable:true,get(){return 500;}},
      scrollTop:{configurable:true,get(){return Math.min(positions.get(this)||0,Math.max(0,this.scrollHeight-this.clientHeight));},set(value){positions.set(this,Math.max(0,Math.min(Number(value)||0,Math.max(0,this.scrollHeight-this.clientHeight))));}},
    });
    await h.click('[aria-label="打开对话：原始主干标题"]');
    const longScroll=h.document.querySelector('.chat-scroll');
    await act(async()=>{longScroll.scrollTop=1410;longScroll.dispatchEvent(new h.window.Event('scroll',{bubbles:true}));});
    await h.click('[aria-label="打开对话：工程方向"]');
    assert.equal(h.document.querySelector('.chat-scroll').scrollTop,0);
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.waitFor(()=>h.document.querySelector('.chat-scroll')?.scrollTop===1410,'long conversation restores its pre-clamp offset');
  });
});

test("branch links stay on their captured message and source navigation highlights that message rather than later history", async () => {
  await withApp(async (h) => {
    const parent = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.first);
    const child = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.branch);
    assert.notEqual(child.source.messageId, parent.messages.at(-1).id);
    await h.click('[aria-label="打开对话：原始主干标题"]');
    const anchored = h.document.querySelector(`.message[data-message-id="${child.source.messageId}"]`);
    assert.ok(anchored.querySelector(".message-branch-links .existing-branch"));
    assert.match(anchored.querySelector(".existing-branch").textContent, /分支：工程验证/);
    const latest = h.document.querySelector(`.message[data-message-id="${parent.messages.at(-1).id}"]`);
    assert.equal(latest.querySelector(".existing-branch"), null);
    await h.click(anchored.querySelector(".existing-branch"));
    assert.match(h.document.querySelector(".chat-title").textContent, /工程方向/);
    await h.click(h.findButton("定位父对话中的来源"));
    assert.match(h.document.querySelector(".chat-title").textContent, /原始主干标题/);
    const focused = h.document.querySelector(".branch-anchor-focus");
    assert.ok(focused);
    assert.equal(focused.closest(".message[data-message-id]").dataset.messageId, child.source.messageId);
    assert.ok(h.scrollCalls.some((call) => call.messageId === child.source.messageId && call.options.block === "center"));
    assert.equal(latest.querySelector(".branch-anchor-focus"), null);
  }, { mutateFixture(data) {
    const parent = data.workspace.boards[0].nodes.find((node) => node.id === data.ids.first);
    const child = data.workspace.boards[0].nodes.find((node) => node.id === data.ids.branch);
    child.source.quote = "这里是详细讨论内容。";
    child.source.anchor.kind = "text"; child.source.anchor.occurrence = 1;
    parent.messages.push(message("user", "在分支创建后才提出的问题"), message("assistant", "此条是后来的回答，不应变成旧分支的来源。"));
  } });
});

test("the integrated overview shows actual references, summary, branch relationships and reported token usage", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.click('[data-conversation-overview-toggle]');
    const overview = h.document.querySelector('[role="dialog"][aria-label="会话概览"]');
    assert.ok(overview);
    assert.match(overview.querySelector(".overview-summary").textContent, /主干：数值推导/);
    assert.match(overview.querySelector(".overview-summary").textContent, /概括整个推导问题/);
    const source = overview.querySelector('.overview-sources a[href="https://docs.example.invalid/reference"]');
    assert.ok(source); assert.equal(source.target, "_blank");
    assert.match(overview.textContent, /未检索、抓取或验证网页/);
    assert.match(overview.textContent, /派生分支[\s\S]*分支：工程验证/);
    const counts = Object.fromEntries([...overview.querySelectorAll(".overview-usage dl > div")]
      .map((item) => [item.querySelector("dt").textContent, item.querySelector("dd").textContent]));
    assert.deepEqual(counts, { 本次输入: "120", 缓存读取: "80", 本次输出: "24" });
    const related = [...overview.querySelectorAll(".overview-node-link")].find((button) => button.textContent.includes("分支：工程验证"));
    await h.click(related);
    assert.equal(h.document.querySelector(".conversation-overview"), null);
    assert.match(h.document.querySelector(".chat-title").textContent, /工程方向/);
    await h.click('[data-conversation-overview-toggle]');
    const childOverview = h.document.querySelector(".conversation-overview");
    assert.match(childOverview.querySelector(".overview-usage").textContent, /服务端未报告用量/);
    await h.click(h.findButton("定位来源消息", childOverview));
    assert.match(h.document.querySelector(".chat-title").textContent, /原始主干标题/);
    assert.ok(h.document.querySelector(".branch-anchor-focus"));
  }, { mutateFixture(data) {
    const parent = data.workspace.boards[0].nodes.find((node) => node.id === data.ids.first);
    parent.messages[0].content += " 参考 [技术资料](https://docs.example.invalid/reference)。";
    parent.messages[1].usage = { inputTokens: 120, outputTokens: 24, cachedInputTokens: 80 };
  } });
});

test("edited source messages open the original branch snapshot instead of highlighting rewritten content", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：工程方向"]');
    await h.click(h.findButton("定位父对话中的来源"));
    const snapshot = h.document.querySelector('[role="dialog"][aria-label="分支创建时的来源快照"]');
    assert.ok(snapshot);
    assert.match(snapshot.querySelector(".dialog-description").textContent, /来源消息后来被编辑/);
    assert.match(snapshot.querySelector(".snapshot-origin").textContent, /渲染加粗/);
    assert.doesNotMatch(snapshot.textContent, /修改后的新回答只在当前会话存在/);
    assert.match(h.document.querySelector(".chat-scroll .message.assistant .message-content").textContent, /修改后的新回答只在当前会话存在/);
    assert.equal(h.document.querySelector(".chat-scroll .branch-anchor-focus"), null);
  }, { mutateFixture(data) {
    data.workspace.boards[0].nodes.find((node) => node.id === data.ids.first).messages[1].content = "修改后的新回答只在当前会话存在。";
  } });
});

test("a branch created from an inherited-only parent opens its saved history rather than guessing a current message", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：继承历史锚点"]');
    await h.click(h.findButton("定位父对话中的来源"));
    const snapshot = h.document.querySelector('[role="dialog"][aria-label="分支创建时的来源快照"]');
    assert.ok(snapshot);
    assert.match(snapshot.querySelector(".dialog-description").textContent, /继承的历史/);
    assert.match(snapshot.querySelector(".snapshot-origin").textContent, /渲染加粗/);
    assert.equal(h.document.querySelector(".chat-scroll .branch-anchor-focus"), null);
  }, { mutateFixture(data) {
    const board = data.workspace.boards[0], parent = board.nodes.find((node) => node.id === data.ids.branch);
    parent.messages = [];
    const child = createNode(board, { parentId: parent.id, title: "继承历史锚点" });
    data.ids.inheritedChild = child.id;
  } });
});

test("new merge can choose a different primary conversation and preserves its exact request prefix", async () => {
  await withApp(async (h) => {
    const original = structuredClone(h.savedWorkspace.boards[0]);
    const primaryContext = buildContext(original, h.ids.branch);
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.conversationAction('merge');
    await h.click('[aria-label="选择会话：工程方向"]');
    await h.type('[name="mergeMainId"]', h.ids.branch);
    assert.equal(h.document.querySelector('[name="mergeMainId"]').value, h.ids.branch);
    await h.click(h.findButton("新建合并会话"));
    await h.flushSave();
    const board = h.savedWorkspace.boards[0], merged = board.nodes.find((node) => node.mergeParents.length);
    assert.equal(merged.parentId, h.ids.branch);
    assert.deepEqual(merged.mergeParents, [h.ids.first]);
    assert.deepEqual(buildContext(board, merged.id).slice(0, primaryContext.length), primaryContext);
    assert.equal(merged.merges[0].nodeId, h.ids.first);
    for (const id of [h.ids.first, h.ids.branch])
      assert.deepEqual(board.nodes.find((node) => node.id === id).messages, original.nodes.find((node) => node.id === id).messages);
    await h.click('[data-conversation-overview-toggle]');
    const overview = h.document.querySelector(".conversation-overview");
    const sources = [...overview.querySelectorAll(".overview-section")].find((section) => section.querySelector("h3")?.textContent === "合并来源");
    assert.match(sources.textContent, /主干：数值推导/);
    assert.match(sources.textContent, /分支：工程验证/);
  });
});

test("append preserves the chosen conversation and repeat append adds no messages or summary requests", async () => {
  await withApp(async (h) => {
    const before = structuredClone(h.savedWorkspace.boards[0]);
    const original = before.nodes.find((node) => node.id === h.ids.first);
    const append = async () => {
      await h.conversationAction('merge');
      await h.click('[name="mergeMode"][value="append"]');
      await h.click('[aria-label="选择会话：工程方向"]');
      await h.type('[name="mergeMainId"]', h.ids.first);
      await h.click(h.findButton("追加到主干"));
    };
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await append();
    await h.waitFor(() => h.document.querySelector(`[data-node-id="${h.ids.first}"] h3`)?.textContent === "模型摘要 1", "one summary after changed append");
    await h.flushSave();
    const firstResult = h.savedWorkspace.boards[0], target = firstResult.nodes.find((node) => node.id === h.ids.first);
    assert.equal(firstResult.nodes.length, before.nodes.length);
    assert.deepEqual(target.messages.slice(0, original.messages.length), original.messages);
    assert.equal(target.messages.length, original.messages.length + 1);
    assert.match(target.messages.at(-1).content, /工程里怎样验证结果/);
    assert.deepEqual(target.mergeParents, original.mergeParents);
    assert.deepEqual(target.merges.map((record) => record.nodeId), [h.ids.branch]);
    assert.equal(h.requests.filter((request) => request.url === "/api/summarize").length, 1);
    const firstMessages = structuredClone(target.messages);
    await append();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
    await h.flushSave();
    assert.deepEqual(h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.first).messages, firstMessages);
    assert.equal(h.requests.filter((request) => request.url === "/api/summarize").length, 1);
    assert.match(h.document.querySelector(".toast").textContent, /没有新的差异内容/);
  }, { settings: { autoSummary: true }, allowSummaries: true });
});

test("append of an ancestor already present in the selected target is a UI no-op without model work", async () => {
  await withApp(async (h) => {
    const original = structuredClone(h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.branch));
    await h.click('[aria-label="打开对话：工程方向"]');
    await h.conversationAction('merge');
    await h.click('[name="mergeMode"][value="append"]');
    await h.click('[aria-label="选择会话：原始主干标题"]');
    await h.type('[name="mergeMainId"]', h.ids.branch);
    await h.click(h.findButton("追加到主干"));
    await h.flushSave();
    const target = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.branch);
    assert.deepEqual(target, original);
    assert.match(h.document.querySelector(".toast").textContent, /无需重复追加或重新总结/);
  }, { settings: { autoSummary: true } });
});

test("archive and trash keep conversation data restorable through their management panels", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：工程方向"]');
    await h.conversationAction('archive');
    await h.click(h.findButton("归档分支"));
    assert.equal(h.document.querySelector('[aria-label="打开对话：工程方向"]'), null);
    await h.click(h.findButton("归档", h.document.querySelector(".management-shortcuts")));
    let entry = [...h.document.querySelectorAll(".management-entry")].find((item) => item.textContent.includes("分支：工程验证"));
    assert.ok(entry);
    await h.click(h.findButton("恢复", entry));
    assert.ok(h.document.querySelector('[aria-label="打开对话：工程方向"]'));
    assert.equal(h.document.querySelector("textarea[aria-label='输入消息']").disabled, false);
    await h.conversationAction('trash');
    await h.click(h.findButton("移入回收站"));
    await h.click(h.findButton("回收站", h.document.querySelector(".management-shortcuts")));
    entry = [...h.document.querySelectorAll(".management-entry")].find((item) => item.textContent.includes("分支：工程验证"));
    assert.ok(entry);
    await h.click(h.findButton("恢复", entry));
    await h.flushSave();
    const restored = h.savedWorkspace.boards[0].nodes.find((n) => n.id === h.ids.branch);
    assert.equal(restored.status, "active");
    assert.equal(restored.messages.length, 2);
    assert.equal(restored.deletedAt, null);
  });
});

test("Escape dismisses only the topmost permanent-delete confirmation and a later confirmation purges and persists the node", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：工程方向"]');
    await h.conversationAction('trash');
    await h.click(h.findButton("移入回收站"));
    await h.flushSave();
    assert.equal(h.savedWorkspace.boards[0].nodes.find((n) => n.id === h.ids.branch).status, "trashed");

    await h.click(h.findButton("回收站", h.document.querySelector(".management-shortcuts")));
    const trash = h.document.querySelector('[role="dialog"][aria-label="回收站"]');
    const entry = [...trash.querySelectorAll(".management-entry")].find((item) => item.textContent.includes("分支：工程验证"));
    await h.click(h.findButton("永久删除", entry));
    let confirmation = h.document.querySelector('[role="dialog"][aria-label="永久删除？"]');
    assert.ok(confirmation);
    assert.equal(h.document.querySelectorAll('[role="dialog"]').length, 2);
    await h.key(confirmation, "Escape");
    assert.ok(confirmation.closest(".modal-shade").classList.contains("presence-exit"));
    assert.equal(trash.closest(".modal-shade").classList.contains("presence-exit"), false);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
    assert.equal(h.document.querySelector('[role="dialog"][aria-label="永久删除？"]'), null);
    assert.equal(h.document.querySelector('[role="dialog"][aria-label="回收站"]'), trash);
    assert.equal(h.document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(entry.isConnected);

    await h.click(h.findButton("永久删除", entry));
    confirmation = h.document.querySelector('[role="dialog"][aria-label="永久删除？"]');
    await h.click(h.findButton("永久删除", confirmation));
    assert.equal(h.document.querySelector('[role="dialog"][aria-label="永久删除？"]'), null);
    assert.ok(h.document.querySelector('[role="dialog"][aria-label="回收站"]'));
    assert.equal(h.document.querySelectorAll(".management-entry").length, 0);
    await h.flushSave();
    assert.equal(h.savedWorkspace.boards[0].nodes.some((n) => n.id === h.ids.branch), false);
    assert.ok(h.savedWorkspace.boards[0].nodes.some((n) => n.id === h.ids.first));
    assert.ok(h.savedWorkspace.boards[0].nodes.some((n) => n.id === h.ids.archived));
    assert.ok(h.requests.filter((request) => request.url === "/api/workspace" && request.method === "PUT").length >= 2);
  });
});

test("application settings save reading preferences and expose the desktop data directory picker", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.click(".settings-entry");
    await h.click(h.findButton("阅读",h.document.querySelector('.preferences-form')));
    await h.type('input[name="fontSize"]', "20");
    await h.type('input[name="lineHeight"]', "2.1");
    const wrap = [...h.document.querySelectorAll(".preference-toggle")].find((label) => label.textContent.includes("代码自动折行"));
    await h.click(wrap.querySelector("input"));
    await h.click(h.findButton("保存设置"));
    assert.equal(h.savedSettings.fontSize, 20);
    assert.equal(h.savedSettings.lineHeight, 2.1);
    assert.equal(h.savedSettings.codeWrap, true);
    assert.equal(h.document.querySelector(".message-content").style.getPropertyValue("--message-font-size"), "20px");
    assert.ok(h.document.querySelector(".message-content").classList.contains("message-code-wrap"));
    assert.equal(h.document.querySelector(".application-shell").style.getPropertyValue("--reading-line-height"), "2.1");
    await h.click(".settings-entry");
    await h.click(h.findButton("本地数据"));
    assert.equal(h.document.querySelector('input[name="dataDirectory"]').value, "D:\\test-branch-data");
    await h.click(h.findButton("选择其他目录"));
    assert.ok(h.bridgeCalls.some(([method]) => method === "chooseDataDirectory"));
    assert.match(h.document.querySelector(".preference-storage-choice").textContent, /D:\\test-new-directory/);
    assert.equal(h.document.querySelector('input[name="storageMode"][value="copy"]').checked, true);
  });
});

test("native material import stores every text part and PDF page as local messages without calling a model", async () => {
  let imports = 0;
  const documents = [
    { name: "工程研究.md", kind: "markdown", parts: [{ text: "MARKDOWN_PART_ONE 原始资料" }, { text: "MARKDOWN_PART_TWO 后续证据" }] },
    { name: "实验记录.pdf", kind: "pdf", parts: [{ page: 2, text: "PDF_PAGE_TWO 可提取原文" }, { page: 5, text: "PDF_PAGE_FIVE 最后证据" }] },
  ];
  await withApp(async (h) => {
    const original = structuredClone(h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.first).messages);
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.nativeCommand("import-materials");
    assert.equal(imports, 1);
    await h.flushSave();
    const node = h.savedWorkspace.boards[0].nodes.find((entry) => entry.id === h.ids.first);
    assert.deepEqual(node.messages.slice(0, original.length), original);
    const materialMessages = node.messages.slice(original.length);
    assert.equal(materialMessages.length, 4);
    assert.deepEqual(materialMessages.map((entry) => entry.role), ["user", "user", "user", "user"]);
    assert.deepEqual(materialMessages.map((entry) => entry.material), [
      { name: documents[0].name, kind: "markdown" }, { name: documents[0].name, kind: "markdown" },
      { name: documents[1].name, kind: "pdf", page: 2 }, { name: documents[1].name, kind: "pdf", page: 5 },
    ]);
    for (const marker of ["MARKDOWN_PART_ONE", "MARKDOWN_PART_TWO", "PDF_PAGE_TWO", "PDF_PAGE_FIVE"])
      assert.ok(materialMessages.some((entry) => entry.content.includes(marker)), marker);
    assert.match(materialMessages[2].content, /第 2 页/);
    assert.match(materialMessages[3].content, /第 5 页/);
    assert.equal(h.requests.filter((entry) => ["/api/chat", "/api/summarize", "/api/compare"].includes(entry.url)).length, 0);
  }, { bridge: { importMaterials: async () => { imports++; return { canceled: false, documents }; } } });
});

test("comparison review resets AI flags, saves only human adoption, and follows a real citation back to its source message", async () => {
  await withApp(async (h) => {
    const sourceMessageId = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.first).messages[0].id;
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.click(h.findButton("比较与结论"));
    await h.click('[aria-label="比较分支：工程方向"]');
    await h.click(h.findButton("生成比较"));
    const results = h.document.querySelector('[aria-label="比较结果"]');
    assert.ok(results);
    assert.deepEqual(h.requests.find((entry) => entry.url === "/api/compare").payload.nodeIds, [h.ids.first, h.ids.branch]);
    assert.equal(h.requests.find((entry) => entry.url === "/api/compare").payload.workspace.boards.length, 1);
    assert.ok([...results.querySelectorAll(".conclusion-confirmations input")].every((input) => !input.checked), "AI-supplied verification/adoption cannot preselect human confirmations");
    await h.click('[aria-label="编辑条目：evidence-agreement"]');
    await h.type('[aria-label="修改比较条目：evidence-agreement"]', "人工修订：先确认推导，再检查工程边界。");
    const reviewed = h.document.querySelector('[aria-label="修改比较条目：evidence-agreement"]').closest(".comparison-item");
    await h.click(reviewed.querySelectorAll(".conclusion-confirmations input")[1]);
    await h.click(h.findButton("确认并保存结论卡"));
    const conclusionView = h.document.querySelector('[aria-label="结论卡内容"]');
    assert.ok(conclusionView);
    assert.equal(conclusionView.querySelector('[aria-label="结论内容：evidence-agreement"]'), null);
    assert.equal(conclusionView.querySelector('.saved-conclusion-item .message-content').textContent.trim(), "人工修订：先确认推导，再检查工程边界。");
    const savedReviewed = conclusionView.querySelectorAll(".saved-conclusion-item")[0];
    assert.equal(savedReviewed.querySelectorAll(".conclusion-confirmations input")[0].checked, false);
    assert.equal(savedReviewed.querySelectorAll(".conclusion-confirmations input")[1].checked, true);
    await h.click(conclusionView.querySelector(".evidence-link"));
    await h.click(h.findButton("打开来源位置", conclusionView));
    assert.equal(h.document.querySelector(".chat-title").textContent, "原始主干标题");
    assert.ok(h.scrollCalls.some((entry) => entry.messageId === sourceMessageId), "citation navigation must scroll the cited saved message");
    await h.flushSave();
    const board = h.savedWorkspace.boards[0], conclusion = board.nodes.find((node) => node.kind === "conclusion");
    assert.ok(conclusion);
    assert.deepEqual(conclusion.conclusion.sourceNodeIds, [h.ids.first, h.ids.branch]);
    assert.deepEqual(conclusion.conclusion.items.map(({ verified, adopted }) => ({ verified, adopted })), [
      { verified: false, adopted: true }, { verified: false, adopted: false },
    ]);
    assert.equal(conclusion.conclusion.items[0].citations[0].messageId, sourceMessageId);
    assert.ok(h.document.querySelector(`[data-node-id="${conclusion.id}"].conclusion-card`));
  }, { allowComparisons: true });
});

function addReviewedConclusion(data) {
  const first = data.workspace.boards[0].nodes.find((node) => node.id === data.ids.first);
  const result = createConclusion(data.workspace, { boardId: data.ids.board, nodeIds: [data.ids.first, data.ids.branch], title: "上下文研究结论", model: "mock-reviewed", items: [
    { id: "confirmed-context", category: "conclusion", text: "UNIQUE_CONFIRMED_CONTEXT：人工确认边界后继续研究。", citations: [{ nodeId: first.id, messageId: first.messages[0].id, quote: first.messages[0].content }] },
    { id: "unconfirmed-context", category: "open", text: "UNCONFIRMED_SHOULD_NOT_SEND：还未验证的假设。", citations: [] },
  ] });
  data.workspace = result.workspace;
  data.ids.conclusion = result.nodeId;
  data.workspace.boards[0].nodes.find((node) => node.id === result.nodeId).conclusion.items[0].adopted = true;
}

test("all context modes send the same role/content shown in the actual request preview and keep full local history", async () => {
  for (const mode of ["full", "selected", "conclusions"]) await withApp(async (h) => {
    const original = structuredClone(h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.branch));
    await h.click('[aria-label="打开对话：工程方向"]');
    await h.type('textarea[aria-label="输入消息"]', `CURRENT_NEW_QUESTION_${mode}`);
    await h.click(".composer-context-button");
    const dialog = h.document.querySelector('[role="dialog"][aria-label="下一次回答的上下文"]');
    await h.click(`[name="contextMode"][value="${mode}"]`);
    if (mode === "selected") {
      await h.click(h.findButton("清空选择", dialog));
      const history = [...dialog.querySelectorAll(".context-entry-list label")].find((entry) => entry.textContent.includes("独立检查边界条件与数值稳定性"));
      await h.click(history.querySelector("input"));
    }
    if (mode === "conclusions") {
      const conclusion = [...dialog.querySelectorAll(".context-options label")].find((entry) => entry.textContent.includes("上下文研究结论"));
      await h.click(conclusion.querySelector("input"));
    }
    await h.click(h.findButton("预览实际请求内容", dialog));
    const preview = [...dialog.querySelectorAll(".request-preview details")].map((entry) => ({
      role: entry.querySelector("summary").textContent.match(/^\d+\.\s+(system|user|assistant)/)[1], content: entry.querySelector("pre").textContent,
    }));
    assert.ok(preview.some((entry) => entry.content.includes(`CURRENT_NEW_QUESTION_${mode}`)));
    if (mode === "selected") assert.deepEqual(preview, [
      { role: "assistant", content: "独立检查边界条件与数值稳定性。" }, { role: "user", content: `CURRENT_NEW_QUESTION_${mode}` },
    ]);
    if (mode === "conclusions") {
      assert.ok(preview.some((entry) => entry.content.includes("UNIQUE_CONFIRMED_CONTEXT")));
      assert.ok(!preview.some((entry) => entry.content.includes("UNCONFIRMED_SHOULD_NOT_SEND")));
    }
    await h.click(h.findButton("使用此上下文", dialog));
    const composer = h.document.querySelector('textarea[aria-label="输入消息"]');
    await h.key(composer, "Enter");
    await h.waitFor(() => h.requests.some((entry) => entry.url === "/api/chat"), `chat request in ${mode} mode`);
    assert.deepEqual(h.requests.find((entry) => entry.url === "/api/chat").payload.messages, preview, `${mode} preview must match actual request messages exactly`);
    await h.flushSave();
    const after = h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.branch);
    assert.equal(after.contextPolicy.mode, mode);
    assert.deepEqual(after.source, original.source);
    assert.deepEqual(after.messages.slice(0, original.messages.length), original.messages);
    assert.equal(after.messages.length, original.messages.length + 2);
    assert.equal(after.messages.at(-2).content, `CURRENT_NEW_QUESTION_${mode}`);
    const ownRequest = buildRequestContext(h.savedWorkspace.boards[0], after.id);
    assert.ok(ownRequest.some((entry) => entry.content.includes(`CURRENT_NEW_QUESTION_${mode}`)));
  }, { allowChat: true, mutateFixture: addReviewedConclusion });
});

test("research state changes mark summaries stale and progress resumes confirmed conclusions and pending branches locally", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：工程方向"]');
    assert.equal(h.document.querySelector(".summary-freshness .stale"), null);
    await h.type('[aria-label="研究状态"]', "verify");
    await h.waitFor(() => h.document.querySelector(".summary-freshness .stale"), "debounced summary freshness after research status change");
    assert.match(h.document.querySelector(".summary-freshness .stale").textContent, /可能过时/);
    assert.match(h.document.querySelector(".research-brief").textContent, /1 项已确认.*2 项待处理/);
    await h.click('[aria-label="研究进展"]');
    const resume = h.document.querySelector('[role="dialog"][aria-label="继续这次研究"]');
    assert.ok(resume);
    assert.match(resume.textContent, /UNIQUE_CONFIRMED_CONTEXT/);
    assert.match(resume.textContent, /UNCONFIRMED_SHOULD_NOT_SEND/);
    const waiting = [...resume.querySelectorAll(".resume-item")].find((entry) => entry.textContent.includes("待验证") && entry.textContent.includes("分支：工程验证"));
    assert.ok(waiting);
    await h.click(waiting);
    assert.equal(h.document.querySelector(".chat-title").textContent, "工程方向");
    await h.flushSave();
    assert.equal(h.savedWorkspace.boards[0].nodes.find((node) => node.id === h.ids.branch).researchStatus, "verify");
    assert.equal(h.requests.filter((entry) => ["/api/chat", "/api/summarize", "/api/compare"].includes(entry.url)).length, 0);
  }, { mutateFixture: (data) => {
    addReviewedConclusion(data);
    const board = data.workspace.boards[0];
    for (const node of board.nodes) if (node.summary) node.summary.evidenceFingerprint = summaryEvidenceFingerprint(board, node.id);
  } });
});

test("offline research demo creates a reviewable comparison and saved conclusion without any model calls even with automatic summaries enabled", async () => {
  await withApp(async (h) => {
    const originalBoardIds = h.savedWorkspace.boards.map((board) => board.id);
    await h.click('[aria-label="研究进展"]');
    const progress = h.document.querySelector('[role="dialog"][aria-label="继续这次研究"]');
    assert.ok(progress);
    await h.click(h.findButton("离线体验完整流程", progress));
    const comparison = h.document.querySelector('[role="dialog"][aria-label="比较分支与整理结论"]');
    assert.ok(comparison);
    assert.equal(comparison.querySelectorAll('.comparison-selection input:checked').length, 2);
    const result = comparison.querySelector('[aria-label="比较结果"]');
    assert.ok(result);
    assert.match(result.textContent, /内置演示.*未调用模型/);
    assert.equal(result.querySelectorAll(".comparison-item").length, 3);
    assert.ok([...result.querySelectorAll(".conclusion-confirmations input")].every((input) => !input.checked));
    await h.click(h.findButton("确认并保存结论卡", comparison));
    assert.ok(h.document.querySelector('[aria-label="结论卡内容"]'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    await h.flushSave();
    assert.equal(h.savedWorkspace.boards.length, originalBoardIds.length + 1);
    assert.ok(!originalBoardIds.includes(h.savedWorkspace.activeBoardId));
    const demo = h.savedWorkspace.boards.find((board) => board.id === h.savedWorkspace.activeBoardId);
    assert.match(demo.title, /离线体验/);
    const conclusion = demo.nodes.find((node) => node.kind === "conclusion");
    assert.ok(conclusion);
    assert.equal(conclusion.conclusion.items.length, 3);
    assert.deepEqual(conclusion.conclusion.items.map((item) => item.category), ["agreement", "difference", "open"]);
    assert.match(conclusion.conclusion.model, /内置演示.*未调用模型/);
    assert.equal(conclusion.conclusion.sourceNodeIds.length, 2);
    assert.ok(conclusion.conclusion.items.every((item) => !item.verified && !item.adopted));
    assert.equal(h.requests.filter((entry) => ["/api/chat", "/api/summarize", "/api/compare"].includes(entry.url)).length, 0);
  }, { settings: { autoSummary: true } });
});

test("revisiting imported material conversations and inherited children never triggers automatic model uploads without material opt-in", async () => {
  await withApp(async (h) => {
    await h.click('[aria-label="打开对话：原始主干标题"]');
    await h.click('[aria-label="打开对话：材料继承子分支"]');
    await h.click(h.findButton("另一画布", h.document.querySelector(".board-list")));
    await h.click(h.findButton("集成测试画布", h.document.querySelector(".board-list")));
    await h.click('[aria-label="打开对话：材料继承子分支"]');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    await h.flushSave();
    const board = h.savedWorkspace.boards.find((entry) => entry.id === h.ids.board);
    assert.equal(board.nodes.find((node) => node.id === h.ids.first).summary, null);
    const child = board.nodes.find((node) => node.id === h.ids.materialChild);
    assert.equal(child.summary, null);
    assert.ok(child.source.context.some((entry) => entry.content.includes("【本地资料：")));
    assert.equal(h.requests.filter((entry) => ["/api/chat", "/api/summarize", "/api/compare"].includes(entry.url)).length, 0);
  }, { settings: { autoSummary: true, autoSummaryMaterials: false }, mutateFixture: (data) => {
    const board = data.workspace.boards[0], source = board.nodes.find((node) => node.id === data.ids.first);
    source.summary = null;
    source.messages.push({ ...message("user", "【本地资料：私人研究.pdf；第 3 页】\n\n只在本地浏览的原文"), material: { name: "私人研究.pdf", kind: "pdf", page: 3 } });
    const child = createNode(board, { parentId: source.id, title: "材料继承子分支" });
    child.messages.push(message("user", "保存的分支问题"), message("assistant", "之前已有的本地回答"));
    data.ids.materialChild = child.id;
    data.workspace.boards.push(createBoard("另一画布"));
  } });
});
