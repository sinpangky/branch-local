import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { summaryEvidenceFingerprint } from "../shared/research.mjs";

const bundleUrl = new URL(`../artifacts/test-overview-${process.pid}.mjs`, import.meta.url);
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/components/ConversationOverview.jsx", import.meta.url))],
  outfile: fileURLToPath(bundleUrl), bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["react", "react/*", "lucide-react"], loader: { ".css": "empty" }, logLevel: "silent",
});
after(() => rm(bundleUrl, { force: true }));
const { default: ConversationOverview, collectConversationSources, collectLocalMaterials, getConversationRelations } = await import(bundleUrl.href);
const makeNode = (id, extra = {}) => ({ id, title: id, parentId: null, messages: [], source: null, mergeParents: [], merges: [], status: "active", ...extra });
const render = (node, extra = {}) => renderToStaticMarkup(React.createElement(ConversationOverview, {
  board: { id: "board", status: "active", nodes: [node] }, node, ...extra,
}));

test("overview extracts and deduplicates real transcript references including Markdown images, without fetching", () => {
  const references = collectConversationSources(makeNode("current", {
    messages: [{ content: "[论文](https://example.com/paper) 和 https://example.com/paper。\n![示意图](https://example.com/image.png)\n[unsafe](javascript:alert(1)) ![bad](data:image/png;base64,bad)" }],
    source: { context: [{ content: "继承的 https://example.com/paper 和 [文档][reference]\n\n[reference]: http://docs.example.org/guide" }] },
    summary: { title: "总结", text: "https://not-in-transcript.example/fake" },
  }));
  assert.equal(references.length, 3);
  assert.deepEqual(references.find((entry) => entry.url === "https://example.com/paper").where, ["当前消息", "继承上下文"]);
  assert.equal(references.find((entry) => entry.url.endsWith("image.png")).image, true);
  assert.ok(references.every((entry) => /^https?:\/\//.test(entry.url)));
  assert.ok(!references.some((entry) => entry.url.includes("not-in-transcript")));
});

test("overview does not rescan Markdown destinations into extra sources with following Chinese prose", () => {
  const references = collectConversationSources(makeNode("current", { messages: [{ content:
    "[文档](https://example.com/guide)。这是不会作为网址的一段说明。\n"
    + "![图片](https://example.com/image.png \"图片标题\")，后续文字。\n"
    + "[带标点的路径](https://example.com/path!?)；继续说明。\n"
    + "[参考][doc]。另一段说明。\n\n[doc]: https://example.com/guide",
  }] }));
  assert.deepEqual(references.map(({ url, label, image }) => ({ url, label, image })), [
    { url: "https://example.com/guide", label: "文档", image: false },
    { url: "https://example.com/image.png", label: "图片", image: true },
    { url: "https://example.com/path!?", label: "带标点的路径", image: false },
  ]);
});

test("overview separates bare URLs from prose punctuation while preserving balanced brackets and percent encoding", () => {
  const encoded = "https://example.com/a%29?q=%E4%B8%AD%EF%BC%89&part=a%2Fb#page-2";
  const balanced = "https://en.wikipedia.org/wiki/Function_(mathematics)";
  const references = collectConversationSources(makeNode("current", { messages: [{ content:
    `（${balanced}）。后面的中文句子。\n`
    + "https://example.com/one，下一句；https://example.com/two）。这是正文。\n"
    + "https://example.com/三（四）?q=1。后续正文\n"
    + `[编码链接](${encoded})。文字\n\`${encoded}\`\n`
    + "```text\nhttps://example.com/code_(sample)).\n```",
  }], source: { context: [{ content: `${balanced}；${encoded}` }] } }));
  assert.deepEqual(references.map(({ url }) => url), [
    balanced, "https://example.com/one", "https://example.com/two",
    new URL("https://example.com/三（四）?q=1").href, encoded, "https://example.com/code_(sample)",
  ]);
  assert.deepEqual(references.find(({ url }) => url === balanced).where, ["当前消息", "继承上下文"]);
  assert.deepEqual(references.find(({ url }) => url === encoded).where, ["当前消息", "继承上下文"]);
});

test("overview still collects literal code, angle links and unused reference definitions without network access", () => {
  const references = collectConversationSources(makeNode("current", { messages: [{ content:
    "<https://example.com/angle?q=a%2Cb>\n\n"
    + "`https://example.com/inline`\n\n```text\nhttps://example.com/fenced\n```\n\n"
    + "[unused]: https://example.com/definition\n",
  }] }));
  assert.deepEqual(references.map(({ url }) => url), [
    "https://example.com/angle?q=a%2Cb", "https://example.com/inline", "https://example.com/fenced", "https://example.com/definition",
  ]);
});

test("overview relationships include branch ancestry, immutable merge snapshots, both merge forms, and deleted sources", () => {
  const root = makeNode("root");
  const source = makeNode("source");
  const current = makeNode("current", {
    parentId: "root", mergeParents: ["source"],
    merges: [{ nodeId: "source", title: "source snapshot", context: [{ role: "user", content: "saved" }] }, { nodeId: "deleted", title: "removed source", context: [] }],
  });
  const child = makeNode("child", { parentId: "current", status: "archived" });
  const appendTarget = makeNode("append", { merges: [{ nodeId: "current" }, { nodeId: "current" }] });
  const newTarget = makeNode("new", { parentId: "current", mergeParents: ["source"] });
  const secondaryTarget = makeNode("secondary", { parentId: "root", mergeParents: ["current"] });
  const board = { nodes: [root, source, current, child, appendTarget, newTarget, secondaryTarget] };
  const before = JSON.stringify(board);
  const relations = getConversationRelations(board, current);
  assert.equal(relations.parent, root);
  assert.deepEqual(relations.children.map((node) => node.id), ["child", "new"]);
  assert.deepEqual(relations.mergeSources.map((entry) => entry.id), ["root", "source", "deleted"]);
  assert.equal(relations.mergeSources.find((entry) => entry.id === "deleted").node, null);
  assert.deepEqual(relations.mergeTargets.map((node) => node.id), ["append", "new", "secondary"]);
  assert.deepEqual(relations.conclusionSources, []); assert.deepEqual(relations.conclusionTargets, []);
  assert.equal(JSON.stringify(board), before);
});

test("conclusion source and target relationships stay distinct from primary and merge edges, including missing sources", () => {
  const source = makeNode("saved-evidence");
  const conclusion = makeNode("conclusion", { kind: "conclusion", conclusion: { sourceNodeIds: [source.id, "removed-evidence"] } });
  const nextConclusion = makeNode("followup-conclusion", { kind: "conclusion", conclusion: { sourceNodeIds: [conclusion.id] } });
  const board = { nodes: [source, conclusion, nextConclusion] };
  const relations = getConversationRelations(board, conclusion);
  assert.equal(relations.parent, null); assert.deepEqual(relations.children, []);
  assert.deepEqual(relations.mergeSources, []); assert.deepEqual(relations.mergeTargets, []);
  assert.deepEqual(relations.conclusionSources, [{ id: source.id, node: source }, { id: "removed-evidence", node: null }]);
  assert.deepEqual(relations.conclusionTargets, [nextConclusion]);
  assert.deepEqual(getConversationRelations(board, null), { parent: null, children: [], mergeSources: [], mergeTargets: [], conclusionSources: [], conclusionTargets: [] });
  const document = new JSDOM(render(conclusion, { board, onNavigate: () => {} })).window.document;
  assert.match(document.querySelector(".overview-conclusion-sources").textContent, /saved-evidence[\s\S]*原结论来源已删除[\s\S]*removed-evidence/);
  assert.match(document.querySelector(".overview-conclusion-targets").textContent, /followup-conclusion/);
});

test("local materials aggregate only real message metadata with sorted pages and no fabricated file links", () => {
  const node = makeNode("materials", { messages: [
    { role: "user", content: "提取文字甲", material: { name: "paper.pdf", kind: "pdf", page: 3 } },
    { role: "user", content: "提取文字乙", material: { name: "paper.pdf", kind: "pdf", page: 1 } },
    { role: "user", content: "第三页的另一段", material: { name: "paper.pdf", kind: "pdf", page: 3 } },
    { role: "user", content: "笔记", material: { name: "<img src=x onerror=alert(1)>.md", kind: "markdown" } },
    { role: "user", content: "paper.pdf 只是普通文件名，没有导入记录" },
  ], source: { context: [{ content: "未保存到当前消息的资料", material: { name: "inherited-only.pdf", kind: "pdf", page: 99 } }] } });
  assert.deepEqual(collectLocalMaterials(node), [
    { name: "paper.pdf", kind: "pdf", pages: [1, 3], messageCount: 3 },
    { name: "<img src=x onerror=alert(1)>.md", kind: "markdown", pages: [], messageCount: 1 },
  ]);
  const document = new JSDOM(render(node)).window.document;
  const materials = document.querySelector(".overview-materials-section");
  assert.equal(materials.querySelectorAll("li").length, 2);
  assert.match(materials.textContent, /PDF · 3 段提取文字 · 第 1、3 页/);
  assert.match(materials.textContent, /原文件不复制到应用数据目录/);
  assert.doesNotMatch(materials.textContent, /inherited-only/);
  assert.equal(materials.querySelector("a,img,script,[onerror]"), null);
});

test("overview reports saved summary time and content freshness without treating old evidence as checked", () => {
  const node = makeNode("fresh", { messages: [{ role: "user", content: "原始问题" }],
    summary: { title: "摘要", text: "真实保存的摘要", model: "local-test", updatedAt: "2026-10-18T02:03:00.000Z" } });
  const board = { id: "board", status: "active", nodes: [node] };
  let document = new JSDOM(render(node, { board })).window.document;
  assert.equal(document.querySelector("time").getAttribute("datetime"), node.summary.updatedAt);
  assert.equal(document.querySelector(".overview-freshness").dataset.stale, "true");
  assert.match(document.querySelector(".overview-freshness").textContent, /尚未核对/);
  node.summary.evidenceFingerprint = summaryEvidenceFingerprint(board, node.id);
  document = new JSDOM(render(node, { board })).window.document;
  assert.equal(document.querySelector(".overview-freshness").dataset.stale, "false");
  assert.match(document.querySelector(".overview-freshness").textContent, /内容与关联未变化/);
  node.messages[0].content += "，以及新的条件";
  document = new JSDOM(render(node, { board })).window.document;
  assert.equal(document.querySelector(".overview-freshness").dataset.stale, "true");
  assert.match(document.querySelector(".overview-freshness").textContent, /内容或关联已变化/);
});

test("overview shows actual saved model summaries, honest empty states, and only reported usage", () => {
  const empty = render(makeNode("empty"));
  assert.match(empty, /尚无模型总结/);
  assert.match(empty, /未检索、抓取或验证网页/);
  assert.match(empty, /服务端未报告用量/);
  assert.doesNotMatch(empty, /AI generated|子代理|已检索|已验证网页/);
  const filled = render(makeNode("filled", { summary: { title: "独特方向", text: "完整会话总结", model: "local-test" } }), {
    usage: { inputTokens: 123, cachedInputTokens: 0, outputTokens: null },
  });
  assert.match(filled, /独特方向/);
  assert.match(filled, /模型：local-test/);
  assert.match(filled, /本次输入<\/dt><dd>123/);
  assert.match(filled, /缓存读取<\/dt><dd>0/);
  assert.match(filled, /本次输出<\/dt><dd>未知/);
});

test("overview never interprets source titles, quotes, summaries, or URLs as executable markup", () => {
  const node = makeNode("bad", {
    summary: { title: '<script>alert(1)</script>', text: '<img src=x onerror="alert(1)">', model: "local" },
    messages: [{ content: '[<img onerror=x>](https://example.com/real) [bad](javascript:alert(1))' }],
  });
  const document = new JSDOM(render(node)).window.document;
  assert.equal(document.querySelector("script,img,[onerror]"), null);
  assert.equal(document.querySelectorAll("a").length, 1);
  assert.equal(document.querySelector("a").getAttribute("rel"), "noopener noreferrer");
  assert.equal(document.querySelector("a").getAttribute("target"), "_blank");
});

test("overview navigation, exact source-owner payloads, summary retry, and Escape/outside-click stay local", async () => {
  const dom = new JSDOM('<!doctype html><button id="toggle" data-conversation-overview-toggle>Toggle</button><div id="root"></div><button id="outside">Outside</button>');
  const previous = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const parent = makeNode("parent");
  const node = makeNode("current", { parentId: "parent", source: { messageId: "m1", quote: "选中的文字", anchor: { kind: "text", occurrence: 1 } } });
  const child = makeNode("child", { parentId: "current", source: { messageId: "m2", quote: "表格", anchor: { kind: "table", blockIndex: 0 } } });
  const conclusion = makeNode("conclusion-target", { kind: "conclusion", conclusion: { sourceNodeIds: [node.id] } });
  const calls = { navigate: [], jump: [], summary: [], close: 0, escapeBubble: 0 };
  let root;
  try {
    for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["IS_REACT_ACT_ENVIRONMENT", true]])
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    dom.window.document.querySelector("#toggle").focus();
    root = createRoot(dom.window.document.querySelector("#root"));
    await act(async () => root.render(React.createElement(ConversationOverview, {
      board: { status: "active", nodes: [parent, node, child, conclusion] }, node,
      summaryState: { status: "error", error: "模型连接失败" },
      onNavigate: (target) => calls.navigate.push(target.id), onJump: (target) => calls.jump.push(target),
      onSummarize: (target) => calls.summary.push(target.id), onClose: () => { calls.close += 1; },
    })));
    const document = dom.window.document;
    await act(async () => document.querySelector(".overview-node-link").click());
    assert.deepEqual(calls.navigate, ["parent"]);
    await act(async () => document.querySelector(".overview-conclusion-targets .overview-node-link").click());
    assert.deepEqual(calls.navigate, ["parent", conclusion.id]);
    for (const button of document.querySelectorAll(".overview-jump")) await act(async () => button.click());
    assert.deepEqual(calls.jump, [
      { nodeId: "parent", sourceNodeId: "current", messageId: "m1", quote: "选中的文字", anchor: { kind: "text", occurrence: 1 } },
      { nodeId: "current", sourceNodeId: "child", messageId: "m2", quote: "表格", anchor: { kind: "table", blockIndex: 0 } },
    ]);
    await act(async () => document.querySelector(".overview-refresh").click());
    assert.deepEqual(calls.summary, ["current"]);
    assert.match(document.querySelector('[role="alert"]').textContent, /模型连接失败/);
    document.querySelector("#toggle").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(calls.close, 0);
    document.querySelector("#outside").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(calls.close, 1);
    const bubble = () => { calls.escapeBubble += 1; };
    dom.window.addEventListener("keydown", bubble);
    document.querySelector(".overview-close").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(calls.close, 2);
    assert.equal(calls.escapeBubble, 0);
    const modal = document.createElement("div");
    modal.className = "modal-shade";
    document.body.append(modal);
    modal.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(calls.close, 2, "A modal above the overview owns its own Escape handling");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
