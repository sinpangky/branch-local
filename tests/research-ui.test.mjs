import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React, { act, useState } from "react";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createBoard, createNode, newId, validateWorkspace } from "../shared/core.mjs";
import { buildRequestContext, createConclusion } from "../shared/research.mjs";
import { comparisonFingerprint, verifyComparisonCitation } from "../shared/comparison.mjs";

const timestamp = "2026-10-18T08:00:00.000Z";
const bundleUrl = new URL(`../artifacts/test-research-ui-${process.pid}.mjs`, import.meta.url);
const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
const previousGlobals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let dom, createRoot, components;

before(async () => {
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL("../src/components/ResearchTools.jsx", import.meta.url))],
    outfile: fileURLToPath(bundleUrl), bundle: true, format: "esm", platform: "browser", target: "es2022",
    external: ["react", "react/*"], loader: { ".css": "empty" }, logLevel: "silent",
  });
  dom = new JSDOM("<!doctype html><body></body>", { url: "https://research.example.invalid", pretendToBeVisual: true });
  for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator], ["IS_REACT_ACT_ENVIRONMENT", true]])
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  ({ createRoot } = await import("react-dom/client"));
  components = await import(bundleUrl.href);
});

after(async () => {
  dom?.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  await rm(bundleUrl, { force: true });
});

const message = (role, content, createdAt = timestamp) => ({ id: newId(), role, content, createdAt });
function fixture() {
  const board = createBoard("研究 UI 测试"), root = board.nodes[0];
  root.title = "研究主线";
  root.messages.push(message("user", "共享问题"), message("assistant", "共享原始依据"));
  const left = createNode(board, { parentId: root.id, title: "左侧研究", quote: "共享原始依据" });
  left.messages.push(message("user", "旧的问题，不应自动纳入指定上下文"), message("assistant", "左侧独有证据：**原子替换**可以保护旧数据。", "2026-10-18T10:00:00.000Z"));
  left.draft = "  现在需要回答的新问题  ";
  const right = createNode(board, { parentId: root.id, title: "右侧研究" });
  right.messages.push(message("user", "事务问题"), message("assistant", "右侧独有证据：提交需要明确边界。"));
  const workspace = validateWorkspace({ version: 2, revision: 4, activeBoardId: board.id, boards: [board] });
  const normalized = workspace.boards[0];
  return { workspace, board: normalized, left: normalized.nodes.find((node) => node.id === left.id), right: normalized.nodes.find((node) => node.id === right.id), root: normalized.nodes[0], ids: [left.id, right.id] };
}

function comparisonFor(data) {
  const citations = [
    { nodeId: data.left.id, messageId: data.left.messages[1].id, quote: "原子替换" },
    { nodeId: data.right.id, contextIndex: 1, quote: "共享原始依据" },
  ];
  for (const citation of citations) assert.deepEqual(verifyComparisonCitation(data.board, data.ids, citation), citation);
  return {
    title: "原子保存研究结论", sourceNodeIds: data.ids, fingerprint: comparisonFingerprint(data.board, data.ids),
    model: "mock-comparison-model", createdAt: timestamp,
    items: [
      { id: "ui-agreement", category: "agreement", text: "保存操作需要明确提交边界。", citations: [citations[0]], verified: true, adopted: true },
      { id: "ui-open", category: "open", text: "异常中断的情况还需要验证。", citations: [citations[1]], verified: true, adopted: true },
    ],
  };
}

async function mount(t, render) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const rerender = async (element) => act(async () => root.render(element));
  await rerender(render);
  return { container, rerender };
}

const button = (container, text) => {
  const result = [...container.querySelectorAll("button")].find((entry) => entry.textContent.includes(text));
  assert.ok(result, `Missing button: ${text}`);
  return result;
};
const click = async (element) => { assert.ok(element); await act(async () => element.click()); };
async function setText(element, text) {
  await act(async () => {
    element.focus();
    const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
const checkForLabel = (container, text) => {
  const label = [...container.querySelectorAll("label")].find((entry) => entry.textContent.includes(text));
  assert.ok(label, `Missing label: ${text}`);
  return label.querySelector("input");
};

function mockFetch(t, implementation) {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = previous; });
}

function actualMessages(data, policy, systemPrompt) {
  const board = structuredClone(data.board), node = board.nodes.find((entry) => entry.id === data.left.id);
  node.contextPolicy = policy;
  const currentMessageId = "actually-submitted-question";
  node.messages.push(message("user", node.draft.trim()));
  node.messages.at(-1).id = currentMessageId;
  return [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), ...buildRequestContext(board, node.id, { currentMessageId })];
}

function previewMessages(container) {
  return [...container.querySelectorAll('.request-preview > details')].map((entry) => ({
    role: entry.querySelector("summary").textContent.match(/^\d+\.\s+(\w+)/)[1],
    content: entry.querySelector("pre").textContent,
  }));
}

test("comparison UI resets model confirmation flags and saves only retained, manually reviewed items", async (t) => {
  const data = fixture(), result = comparisonFor(data), requests = [], changes = [], saved = [], controllers = [];
  mockFetch(t, async (url, options) => {
    requests.push({ url, options });
    return Response.json({ comparison: result });
  });
  function Harness() {
    const [session, setSession] = useState({ selection: data.ids, result: null, title: "", items: [] });
    return React.createElement(components.ComparisonWorkbench, {
      ...data, session, onChange: (next) => { changes.push(next); setSession(next); },
      onSave: (value) => saved.push(value), onJump() {}, onRequest: (controller) => controllers.push(controller),
    });
  }
  const { container } = await mount(t, React.createElement(Harness));
  assert.ok(container.querySelector('.comparison-navigation'));
  assert.ok(container.querySelector('.comparison-reading .comparison-empty'));
  assert.equal(container.querySelector('[aria-label="比较流程"]').children.length, 3);
  await click(button(container, "生成比较"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/compare");
  assert.equal(requests[0].options.method, "POST");
  const sent = JSON.parse(requests[0].options.body);
  assert.deepEqual(sent.nodeIds, data.ids);
  assert.equal(sent.boardId, data.board.id);
  assert.equal(sent.workspace.boards.length, 1);
  assert.equal(sent.workspace.activeBoardId, data.board.id);
  assert.deepEqual(sent.workspace.boards[0], data.board);
  const generated = changes.at(-1);
  assert.ok(generated.items.every((item) => item.included && item.verified === false && item.adopted === false));
  assert.equal(container.querySelectorAll(".comparison-results .conclusion-confirmations input:checked").length, 0);
  assert.ok(controllers[0] instanceof AbortController);
  assert.equal(controllers.at(-1), null);
  const first = container.querySelector(".comparison-item");
  assert.equal(first.querySelector('textarea'), null);
  assert.match(first.querySelector('.message-content').textContent, /保存操作需要明确提交边界/);
  const group = container.querySelector('[data-comparison-category="agreement"]');
  group.open = false;
  await click(container.querySelector('.comparison-group-nav button'));
  assert.equal(group.open, true);
  assert.equal(dom.window.document.activeElement, group.querySelector('summary'));
  await click(checkForLabel(first, "我已验证"));
  await click(checkForLabel(first, "我决定采用"));
  await click(container.querySelector('[aria-label="保留条目：ui-open"]'));
  await click(button(container, "确认并保存结论卡"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].items.length, 1);
  assert.equal(saved[0].items[0].id, "ui-agreement");
  assert.equal(saved[0].items[0].verified, true);
  assert.equal(saved[0].items[0].adopted, true);
  assert.deepEqual(saved[0].items[0].citations, result.items[0].citations);
});

test("comparison UI rejects saving after any selected source evidence changes", async (t) => {
  const data = fixture(), result = comparisonFor(data), saved = [];
  const session = { selection: data.ids, result, title: result.title, items: result.items.map((item) => ({ ...item, included: true, verified: false, adopted: false })) };
  const props = { ...data, session, onChange() {}, onSave: (value) => saved.push(value), onJump() {} };
  const { container, rerender } = await mount(t, React.createElement(components.ComparisonWorkbench, props));
  assert.equal(button(container, "确认并保存结论卡").disabled, false);
  const changed = structuredClone(data.board);
  changed.nodes.find((node) => node.id === data.left.id).messages[1].content += " 原文已修订。";
  await rerender(React.createElement(components.ComparisonWorkbench, { ...props, board: changed }));
  assert.match(container.querySelector('[role="alert"]').textContent, /来源会话已变化/);
  assert.equal(button(container, "确认并保存结论卡").disabled, true);
  await click(button(container, "确认并保存结论卡"));
  assert.deepEqual(saved, []);
  const removed = { ...data.board, nodes: data.board.nodes.filter((node) => node.id !== data.left.id) };
  await rerender(React.createElement(components.ComparisonWorkbench, { ...props, board: removed }));
  assert.match(container.querySelector('[role="alert"]').textContent, /来源会话已变化/);
  assert.equal(button(container, "确认并保存结论卡").disabled, true);
  await click(button(container, "确认并保存结论卡"));
  assert.deepEqual(saved, []);
});

test("comparison reading mode has explicit editing that clears confirmation and offers an independent cancel action", async (t) => {
  const data=fixture(),result=comparisonFor(data),saved=[],cancelled=[];
  function Harness(){
    const [session,setSession]=useState({selection:data.ids,result,title:result.title,items:result.items.map((item)=>({...item,included:true}))});
    return React.createElement(components.ComparisonWorkbench,{...data,session,onChange:setSession,onJump(){},onSave:(value)=>saved.push(value),onCancel:()=>cancelled.push(true)});
  }
  const {container}=await mount(t,React.createElement(Harness));
  const item=container.querySelector('.comparison-item');
  assert.equal(item.querySelector('textarea'),null);
  await click(item.querySelector('[aria-label="编辑条目：ui-agreement"]'));
  const textarea=item.querySelector('[aria-label="修改比较条目：ui-agreement"]');
  await setText(textarea,'**人工审阅**后的内容');
  assert.equal(item.querySelectorAll('.conclusion-confirmations input:checked').length,0);
  await act(async()=>textarea.blur());
  assert.equal(item.querySelector('textarea'),null);
  assert.equal(item.querySelector('.message-content strong').textContent,'人工审阅');
  await click(container.querySelector('.comparison-save .secondary'));
  assert.deepEqual(cancelled,[true]);
  assert.deepEqual(saved,[]);
});

test("context layout keeps selected counts and local request preview together, and cancellation does not save policy", async (t)=>{
  const data=fixture(),saved=[],cancelled=[];
  mockFetch(t,()=>{throw new Error('Context review must remain local');});
  const {container}=await mount(t,React.createElement(components.ContextPicker,{...data,node:data.left,onSave:(policy)=>saved.push(policy),onCancel:()=>cancelled.push(true)}));
  assert.equal(container.querySelector('.context-preview-pane [role=status]').textContent,'5 条消息');
  await click(container.querySelector('input[value="selected"]'));
  await click(checkForLabel(container,'左侧独有证据'));
  assert.equal(container.querySelector('.context-selection-pane .research-pane-title>span').textContent,'1 / 4');
  assert.equal(container.querySelector('.context-preview-pane [role=status]').textContent,'2 条消息');
  await click(container.querySelector('.context-save-actions .secondary'));
  assert.deepEqual(cancelled,[true]);
  assert.deepEqual(saved,[]);
});

test("selected-message context preview exactly matches the next model request and retains the draft once", async (t) => {
  const data = fixture(), saved = [], systemPrompt = "只根据已选择的资料回答。";
  mockFetch(t, () => { throw new Error("Picking context must not call a model"); });
  const { container } = await mount(t, React.createElement(components.ContextPicker, {
    board: data.board, node: data.left, systemPrompt, onSave: (policy) => saved.push(policy),
  }));
  assert.ok(container.querySelector('.context-selection-pane'));
  assert.ok(container.querySelector('.context-preview-pane'));
  await click(container.querySelector('input[type="radio"][value="selected"]'));
  await click(checkForLabel(container, "共享原始依据"));
  await click(checkForLabel(container, "左侧独有证据"));
  await click(button(container, "预览实际请求内容"));
  await click(button(container, "使用此上下文"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mode, "selected");
  assert.deepEqual(saved[0].refs, [{ kind: "inherited", index: 1 }, { kind: "message", id: data.left.messages[1].id }]);
  const preview = previewMessages(container);
  assert.deepEqual(preview, actualMessages(data, saved[0], systemPrompt));
  assert.equal(preview.filter((entry) => entry.content === data.left.draft.trim()).length, 1);
  assert.ok(!preview.some((entry) => entry.content.includes("旧的问题")));
});

function dataWithConclusions() {
  const data = fixture();
  let workspace = data.workspace;
  const add = (title, text, category = "conclusion") => {
    const saved = createConclusion(workspace, {
      boardId: data.board.id, nodeIds: data.ids, title, model: "offline-test", createdAt: timestamp,
      items: [{ id: newId(), text, category, citations: [{ nodeId: data.left.id, messageId: data.left.messages[1].id, quote: "原子替换" }] }],
    });
    workspace = saved.workspace;
    return saved.nodeId;
  };
  const chosenId = add("选中的结论卡", "已验证且被选择的结论");
  const otherId = add("未选择的结论卡", "不能自动加入请求的其他结论");
  const archivedId = add("归档结论卡", "归档卡不能成为可选结论");
  const board = workspace.boards[0];
  const chosen = board.nodes.find((node) => node.id === chosenId);
  chosen.conclusion.items[0].verified = true;
  chosen.conclusion.items.push({ id: "unconfirmed-guess", text: "同卡未确认的猜测也不能加入", category: "open", citations: [], verified: false, adopted: false });
  board.nodes.find((node) => node.id === otherId).conclusion.items[0].adopted = true;
  board.nodes.find((node) => node.id === archivedId).conclusion.items[0].verified = true;
  board.nodes.find((node) => node.id === archivedId).status = "archived";
  return { ...data, workspace, board, left: board.nodes.find((node) => node.id === data.left.id), chosen, otherId, archivedId };
}

test("conclusion context includes only explicitly chosen active cards and their confirmed items", async (t) => {
  const data = dataWithConclusions(), saved = [], systemPrompt = "Research system prompt";
  mockFetch(t, () => { throw new Error("Picking conclusions must remain local"); });
  const { container } = await mount(t, React.createElement(components.ContextPicker, {
    board: data.board, node: data.left, systemPrompt, onSave: (policy) => saved.push(policy),
  }));
  await click(container.querySelector('input[type="radio"][value="conclusions"]'));
  assert.doesNotMatch(container.querySelector(".context-options").textContent, /归档结论卡/);
  await click(checkForLabel(container, "选中的结论卡"));
  await click(button(container, "预览实际请求内容"));
  await click(button(container, "使用此上下文"));
  assert.deepEqual(saved[0].conclusionIds, [data.chosen.id]);
  const preview = previewMessages(container);
  assert.deepEqual(preview, actualMessages(data, saved[0], systemPrompt));
  const material = preview[1].content;
  assert.match(material, /已验证且被选择的结论/);
  assert.doesNotMatch(material, /不能自动加入|未确认的猜测|归档卡不能|共享原始依据/);
  assert.deepEqual(preview.slice(2).map((entry) => entry.content), [...data.left.messages.map((entry) => entry.content), data.left.draft.trim()]);
});

test("evidence buttons show the saved quotation inline, preview current source text, and jump to its exact location", async (t) => {
  const data = fixture(), citations = comparisonFor(data).items.flatMap((item) => item.citations), jumps = [];
  const { container } = await mount(t, React.createElement(components.EvidenceLinks, {
    citations, board: data.board, onJump: (citation) => jumps.push(citation),
  }));
  const links = container.querySelectorAll(".evidence-link");
  await click(links[0]);
  assert.equal(links[0].getAttribute('aria-expanded'), 'true');
  let preview = container.querySelector(".evidence-preview");
  assert.equal(preview.querySelector("blockquote").textContent, citations[0].quote);
  assert.match(preview.querySelector("details").textContent, /左侧独有证据/);
  assert.equal(preview.querySelector("strong").textContent, "原子替换");
  await click(button(preview, "打开来源位置"));
  assert.deepEqual(jumps[0], citations[0]);
  await click(links[1]);
  preview = container.querySelector(".evidence-preview");
  assert.equal(preview.querySelector("blockquote").textContent, "共享原始依据");
  await click(button(preview, "打开来源位置"));
  assert.deepEqual(jumps[1], citations[1]);
  assert.equal(jumps[1].contextIndex, 1);
  await click(container.querySelector('[aria-label="关闭证据预览"]'));
  assert.equal(container.querySelector('.evidence-preview'), null);
  assert.equal(links[1].getAttribute('aria-expanded'), 'false');
});

test("editing a saved conclusion commits on blur and clears its old verification and adoption", async (t) => {
  const data = dataWithConclusions(), updates = [], exports = [];
  data.chosen.conclusion.items[0].adopted = true;
  const itemId = data.chosen.conclusion.items[0].id;
  function Harness() {
    const [node, setNode] = useState(structuredClone(data.chosen));
    return React.createElement(components.ConclusionView, {
      node, board: data.board, onJump() {}, onExport: () => exports.push(true),
      onChangeItem: (id, patch) => {
        updates.push({ id, patch });
        setNode((current) => ({ ...current, conclusion: { ...current.conclusion, items: current.conclusion.items.map((item) => item.id === id ? { ...item, ...patch } : item) } }));
      },
    });
  }
  const { container } = await mount(t, React.createElement(Harness));
  const first = container.querySelector(".saved-conclusion-item");
  assert.equal(first.querySelector('textarea'), null, 'conclusions start in rendered reading mode');
  assert.match(first.querySelector('.message-content').textContent, /已验证且被选择的结论/);
  assert.equal(first.querySelectorAll('input[type="checkbox"]:checked').length, 2);
  await click(container.querySelector(`[aria-label="编辑结论：${itemId}"]`));
  let textarea = container.querySelector(`[aria-label="结论内容：${itemId}"]`);
  assert.equal(dom.window.document.activeElement, textarea);
  await setText(textarea, "人工核对后重新修改的结论");
  assert.deepEqual(updates, []);
  await act(async () => textarea.blur());
  assert.deepEqual(updates, [{ id: itemId, patch: { text: "人工核对后重新修改的结论", verified: false, adopted: false } }]);
  assert.equal(first.querySelectorAll('input[type="checkbox"]:checked').length, 0);
  assert.equal(first.querySelector('textarea'), null);
  assert.equal(first.querySelector('.message-content').textContent.trim(), "人工核对后重新修改的结论");
  await click(container.querySelector(`[aria-label="编辑结论：${itemId}"]`));
  textarea = container.querySelector(`[aria-label="结论内容：${itemId}"]`);
  await setText(textarea, "  ");
  await act(async () => textarea.blur());
  assert.equal(updates.length, 1);
  assert.equal(first.querySelector('.message-content').textContent.trim(), "人工核对后重新修改的结论");
  await click(container.querySelector(`[aria-label="编辑结论：${itemId}"]`));
  textarea = container.querySelector(`[aria-label="结论内容：${itemId}"]`);
  await setText(textarea, '不应被保存的取消内容');
  await act(async()=>textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.equal(updates.length, 1);
  assert.equal(first.querySelector('textarea'), null);
  assert.equal(first.querySelector('.message-content').textContent.trim(), "人工核对后重新修改的结论");
  await click(button(container, "导出 Markdown"));
  assert.deepEqual(exports, [true]);
});

test("research resume uses local recorded progress and navigates without generating claims or model requests", async (t) => {
  const data = dataWithConclusions(), navigated = [], compares = [], demos = [];
  data.left.researchStatus = "verify";
  mockFetch(t, () => { throw new Error("Resuming research must not call a model"); });
  const { container } = await mount(t, React.createElement(components.ResearchResume, {
    board: data.board, onNavigate: (node) => navigated.push(node), onCompare: () => compares.push(true), onDemo: () => demos.push(true),
  }));
  assert.match(container.textContent, /来自本地消息/);
  assert.match(container.textContent, /已验证且被选择的结论/);
  assert.doesNotMatch(container.textContent, /归档卡不能成为可选结论/);
  await click(container.querySelector(".resume-latest button"));
  assert.equal(navigated[0].id, data.left.id);
  await click(button(container, "比较分支，整理结论"));
  await click(button(container, "离线体验完整流程"));
  assert.deepEqual(compares, [true]);
  assert.deepEqual(demos, [true]);
});

test("switching a conclusion into read-only mode abandons its open editor without writing unreviewed text", async (t)=>{
  const data=dataWithConclusions(),updates=[];
  const props={node:data.chosen,board:data.board,onChangeItem:(...args)=>updates.push(args),onJump(){},onExport(){},readOnly:false};
  const {container,rerender}=await mount(t,React.createElement(components.ConclusionView,props));
  const id=data.chosen.conclusion.items[0].id;
  await click(container.querySelector(`[aria-label="编辑结论：${id}"]`));
  await setText(container.querySelector(`[aria-label="结论内容：${id}"]`),'尚未提交的文本');
  await rerender(React.createElement(components.ConclusionView,{...props,readOnly:true}));
  assert.equal(container.querySelector('textarea'),null);
  assert.equal(container.querySelector('.conclusion-edit'),null);
  assert.match(container.querySelector('.message-content').textContent,/已验证且被选择的结论/);
  assert.deepEqual(updates,[]);
});
