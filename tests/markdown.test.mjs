import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import {
  normalizeMessageText,
  renderMessageHtml,
} from "../shared/markdown.mjs";

const window = new JSDOM("").window;
const purifier = createDOMPurify(window);
const render = (text) => renderMessageHtml(text, {
  sanitize: (html, config) => purifier.sanitize(html, config),
});
const documentFor = (text) => new JSDOM(render(text)).window.document;

test("message renderer creates readable Markdown structure, emphasis, tables, tasks and links", () => {
  const document = documentFor([
    "# 清晰的标题", "", "**加粗**和*强调*，以及 `inline_code`。", "",
    "> 一段引用", "", "1. 第一步", "2. 第二步", "", "- [x] 已完成", "",
    "| 项目 | 结果 |", "| :--- | ---: |", "| A | 42 |", "",
    "[官方文档](https://example.com/docs)",
  ].join("\n"));
  assert.equal(document.querySelector("h1").textContent, "清晰的标题");
  assert.equal(document.querySelector("strong").textContent, "加粗");
  assert.equal(document.querySelector("em").textContent, "强调");
  assert.equal(document.querySelector("code").textContent, "inline_code");
  assert.equal(document.querySelector("blockquote").textContent.trim(), "一段引用");
  assert.equal(document.querySelectorAll("ol li").length, 2);
  assert.equal(document.querySelector("input").disabled, true);
  assert.equal(document.querySelectorAll("table tbody td").length, 2);
  assert.equal(document.querySelector("a").getAttribute("rel"), "noopener noreferrer");
});

test("all four LaTeX delimiters render locally, retaining fractions and subscripts", () => {
  const document = documentFor(String.raw`行内 $x_i^2$ 和 \(\frac{a_b}{c_d}\)。

$$\sum_{i=1}^n i = \frac{n(n+1)}{2}$$

\[
A_{ij} = \begin{cases}1 & i=j\\0 & i\ne j\end{cases}
\]`);
  assert.equal(document.querySelectorAll(".katex").length, 4);
  assert.equal(document.querySelectorAll(".katex-display").length, 2);
  assert.equal(document.querySelectorAll("math").length, 4);
  assert.ok(document.querySelector(".mfrac"));
  assert.ok(document.querySelector(".msupsub"));
  assert.equal(document.querySelector(".katex-error"), null);
});

test("math cannot swallow surrounding prose emphasis or be damaged by Markdown underscores", () => {
  const document = documentFor(String.raw`_公式 $a_ b=c_ d$ 是这个_，**也有 \(a_b\) 和 $x^2$**。`);
  assert.equal(document.querySelectorAll(".katex").length, 3);
  assert.match(document.querySelector("em").textContent, /^公式 /);
  assert.match(document.querySelector("em").textContent, / 是这个$/);
  assert.ok(document.querySelector("strong .katex"));
});

test("code fences and inline code preserve math markers, literal newlines, and program text", () => {
  const source = [
    "```javascript", String.raw`const source = "$x$ and \\(x\\) and \\n";`, "```", "",
    String.raw`行内示例：\`$not_math$\` 和 \`\(not_math\)\`。`.replace(/\\`/g, "`"),
  ].join("\n");
  const document = documentFor(source);
  assert.equal(document.querySelector(".katex"), null);
  assert.ok(document.querySelector(".hljs-keyword"));
  assert.equal(document.querySelector("pre code").textContent, String.raw`const source = "$x$ and \\(x\\) and \\n";`);
  assert.ok(document.querySelector("button[data-copy-code]"));
  assert.equal(document.querySelectorAll("code").length, 3);
});

test("fenced Markdown used inside a normal explanation stays a code example", () => {
  const document = documentFor("下面是 Markdown 语法：\n\n```markdown\n**bold** and $x$\n```\n\n照此填写。");
  assert.equal(document.querySelector("pre code").textContent, "**bold** and $x$");
  assert.equal(document.querySelector("strong"), null);
  assert.equal(document.querySelector(".katex"), null);
});

test("explicit whole-response markdown fences and JSON wrappers are decoded conservatively", () => {
  const content = String.raw`## 标题
**加粗**，\(x_i\)。

\`C:\new\test\`、\`print("\\n")\``.replace(/\\`/g, "`");
  const wrapped = "```markdown\n" + content + "\n```";
  for (const source of [content, wrapped, JSON.stringify(wrapped), JSON.stringify(JSON.stringify(wrapped))]) {
    const document = documentFor(source);
    assert.equal(document.querySelector("h2").textContent, "标题");
    assert.equal(document.querySelector("strong").textContent, "加粗");
    assert.equal(document.querySelectorAll(".katex").length, 1);
    assert.equal(document.querySelector("code").textContent, String.raw`C:\new\test`);
  }
  assert.equal(normalizeMessageText(String.raw`Use \\n and C:\new\test`), String.raw`Use \\n and C:\new\test`);
  assert.equal(normalizeMessageText('"unfinished JSON\\n'), '"unfinished JSON\\n');
});

test("currency, escaped dollar signs, and unfinished math remain ordinary text", () => {
  const source = String.raw`费用 $5 / $10，折扣 $8；写作 \$x\$。未完成 $x_i 与 \(a_b`;
  const document = documentFor(source);
  assert.equal(document.querySelector(".katex"), null);
  assert.match(document.body.textContent, /费用 \$5 \/ \$10/);
  assert.match(document.body.textContent, /写作 \$x\$/);
});

test("unknown code languages escape their content and cannot inject markup", () => {
  const document = documentFor('```unknown-language\n<img src=x onerror=alert(1)>\n```');
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector("pre code").textContent, "<img src=x onerror=alert(1)>");
  assert.match(document.querySelector(".message-code-header").textContent, /unknown-language/);
});

test("Markdown images are safe references with explicit loading controls and never become automatic or raw HTML images", () => {
  const document = documentFor([
    '![架构图](https://images.example.com/architecture.png)',
    '![本地引用](http://images.example.com/plain.png)',
    '![不安全](javascript:alert%281%29)',
    '![内嵌](data:image/png;base64,evil)',
    '<img src="https://images.example.com/raw.png" onerror="alert(1)">',
  ].join("\n\n"));
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelectorAll("[data-image-ref]").length, 2);
  assert.equal(document.querySelectorAll("button[data-load-image]").length, 1);
  const secure = document.querySelector('[data-image-ref="https://images.example.com/architecture.png"]');
  assert.equal(secure.dataset.imageAlt, "架构图");
  assert.equal(secure.querySelector("a").getAttribute("rel"), "noopener noreferrer");
  assert.equal(secure.querySelector("a").getAttribute("target"), "_blank");
  const plain = document.querySelector('[data-image-ref="http://images.example.com/plain.png"]');
  assert.equal(plain.querySelector("button"), null);
  assert.match(plain.textContent, /HTTP 图片仅支持查看原图/);
  assert.equal(document.querySelector('[href^="javascript:"],[src^="data:"],[onerror]'), null);
});

test("Markdown image examples inside code remain literal and a linked image retains separate safe destinations", () => {
  const document = documentFor('`![literal](https://example.com/code.png)`\n\n[![diagram](https://example.com/image.png)](https://example.com/page)');
  assert.equal(document.querySelector("code").textContent, "![literal](https://example.com/code.png)");
  assert.equal(document.querySelectorAll("[data-image-ref]").length, 1);
  assert.equal(document.querySelector("a a, a button"), null);
  assert.equal(document.querySelectorAll("a").length, 2);
  assert.ok(document.querySelector('[href="https://example.com/page"]'));
});

test("untrusted HTML, CSS, handlers, javascript links, and math extensions cannot execute", () => {
  const document = documentFor(String.raw`<script>alert(1)</script>
<iframe src="https://evil.example"></iframe>
<div style="position:fixed" onclick="alert(1)">hello</div>
[坏链接](javascript:alert%281%29)
[另一个](data:text/html,test)

$\href{javascript:alert(1)}{click}$
$\htmlStyle{position:fixed}{danger}$
$\text{<img src=x onerror=alert(1)>}$`);
  assert.equal(document.querySelector("script,iframe,img,object,embed,form"), null);
  assert.equal(document.querySelector('[href^="javascript:"],[href^="data:"]'), null);
  assert.equal(document.querySelector('[onclick],[onerror]'), null);
  assert.equal(document.querySelector('[style*="position:fixed"]'), null);
  assert.equal(document.querySelectorAll(".katex").length, 3);
});

test("trusted math placeholders cannot be spoofed by model content", () => {
  const document = documentFor('BRANCHLOCALMATHTOKEN0END <span data-message-formula="0"></span> &lt;span data-message-formula="0"&gt;&lt;/span&gt; and $x^2$');
  assert.match(document.body.textContent, /BRANCHLOCALMATHTOKEN0END/);
  assert.equal(document.querySelectorAll(".katex").length, 1);
});

test("streaming partial Markdown, invalid formulas, and expansion limits never blank the response", () => {
  const source = String.raw`**结果**：\(\frac{x_i}{y_j}\)。

$$\sum_{i=1}^n i$$

\`$raw$\``.replace(/\\`/g, "`");
  for (let length = 1; length <= source.length; length += 1) {
    const html = render(source.slice(0, length));
    assert.equal(typeof html, "string");
    assert.ok(html.length > 0);
  }
  const bad = documentFor(String.raw`前面 $\frac{a}{$ 后面 $\def\a{\a}\a$ 结束`);
  assert.match(bad.body.textContent, /前面/);
  assert.match(bad.body.textContent, /结束/);
  assert.ok(bad.querySelector(".katex-error"));
});

test("without a DOM sanitizer Node uses an escaped safe fallback", () => {
  const html = renderMessageHtml('<script>alert(1)</script>\n**bold**');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("message component copies exact code via the desktop bridge, then browser clipboard, and reports failures", async () => {
  const bundleUrl = new URL(`../artifacts/test-message-component-${process.pid}.mjs`, import.meta.url);
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL("../src/components/MessageContent.jsx", import.meta.url))],
    outfile: fileURLToPath(bundleUrl),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["react", "react/*"],
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://local.example" });
  const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root;
  try {
    for (const [key, value] of [
      ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
      ["IS_REACT_ACT_ENVIRONMENT", true],
    ]) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const { default: MessageContent } = await import(bundleUrl.href);
    root = createRoot(dom.window.document.querySelector("#root"));
    const bridgeCalls = [];
    const clipboardCalls = [];
    dom.window.branchDesktop = { copyText: async (text) => bridgeCalls.push(text) };
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => clipboardCalls.push(text) },
    });
    await act(async () => root.render(React.createElement(MessageContent, {
      text: "```javascript\nconst value = 42;\n```", codeWrap: true, fontSize: 17,
    })));
    const content = dom.window.document.querySelector(".message-content");
    assert.ok(content.classList.contains("message-code-wrap"));
    assert.equal(content.style.getPropertyValue("--message-font-size"), "17px");
    let button = content.querySelector("button[data-copy-code]");
    await act(async () => button.click());
    assert.deepEqual(bridgeCalls, ["const value = 42;"]);
    assert.deepEqual(clipboardCalls, []);
    assert.equal(button.textContent, "已复制");

    delete dom.window.branchDesktop;
    await act(async () => root.render(React.createElement(MessageContent, { text: "```text\nbrowser copy\n```" })));
    button = content.querySelector("button[data-copy-code]");
    await act(async () => button.click());
    assert.deepEqual(clipboardCalls, ["browser copy"]);
    assert.equal(button.textContent, "已复制");

    dom.window.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
    await act(async () => root.render(React.createElement(MessageContent, { text: "```text\ncopy denied\n```" })));
    button = content.querySelector("button[data-copy-code]");
    await act(async () => button.click());
    assert.equal(button.textContent, "复制失败");
    assert.match(button.getAttribute("aria-label"), /手动复制/);
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(bundleUrl, { force: true });
  }
});

test("message block controls branch from actual tables and image references, navigate matching branches, and load HTTPS images only on request", async () => {
  const bundleUrl = new URL(`../artifacts/test-message-blocks-${process.pid}.mjs`, import.meta.url);
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL("../src/components/MessageContent.jsx", import.meta.url))],
    outfile: fileURLToPath(bundleUrl), bundle: true, format: "esm", platform: "browser", target: "es2022",
    external: ["react", "react/*"], loader: { ".css": "empty" }, logLevel: "silent",
  });
  // JSDOM's external resource loading is disabled; image load/error events are
  // dispatched explicitly, and this test never fetches an image or a model.
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const text = '第一处：重复词。\n\n第二处：重复词。\n\n|变量|值|\n|---|---|\n|x|2|\n\n![架构图](https://images.example.com/diagram.png)\n\n|状态|说明|\n|---|---|\n|完成|有效|\n\n![HTTP图](http://images.example.com/plain.png)';
  const branches = [];
  const opened = [];
  const branchLinks = [
    { id: "table-child", title: "表格的分支", anchor: { kind: "table", blockIndex: 0 } },
    { id: "image-child", title: "图片的分支", anchor: { kind: "image", blockIndex: 0, imageUrl: "https://images.example.com/diagram.png" } },
    { id: "wrong-image", title: "其他图片", anchor: { kind: "image", blockIndex: 0, imageUrl: "https://images.example.com/other.png" } },
    { id: "text-child", title: "文字的分支", quote: "重复词", anchor: { kind: "text", occurrence: 1 } },
    { id: "missing-text", title: "无法匹配的旧分支", quote: "当前原文中不存在", anchor: { kind: "text", occurrence: 0 } },
  ];
  let root;
  try {
    for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator], ["IS_REACT_ACT_ENVIRONMENT", true]])
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const { default: MessageContent } = await import(bundleUrl.href);
    root = createRoot(dom.window.document.querySelector("#root"));
    const props = { text, onBranchBlock: (anchor) => branches.push(anchor), branchLinks, onOpenBranch: (id) => opened.push(id) };
    await act(async () => root.render(React.createElement(MessageContent, props)));
    const document = dom.window.document;
    assert.equal(document.querySelectorAll(".message-block-tools").length, 5);
    assert.equal(document.querySelectorAll("button[data-open-branch]").length, 3);
    assert.match(document.querySelector(".message-text-branch-tools").previousElementSibling.textContent, /第二处/);
    assert.equal(document.querySelector('[data-open-branch="missing-text"]'), null);
    assert.equal(document.querySelector("img"), null);
    for (const button of document.querySelectorAll('button[data-branch-block="table"]')) await act(async () => button.click());
    await act(async () => document.querySelector('button[data-branch-block="image"]').click());
    assert.deepEqual(branches, [
      { kind: "table", blockIndex: 0, quote: "变量 | 值\nx | 2" },
      { kind: "table", blockIndex: 1, quote: "状态 | 说明\n完成 | 有效" },
      { kind: "image", blockIndex: 0, quote: "架构图", imageUrl: "https://images.example.com/diagram.png" },
    ]);
    for (const button of document.querySelectorAll("button[data-open-branch]")) await act(async () => button.click());
    assert.deepEqual(opened, ["text-child", "table-child", "image-child"]);
    const focusedTool = document.querySelector('button[data-branch-block="table"]');
    focusedTool.focus();
    await act(async () => root.render(React.createElement(MessageContent, {
      ...props, branchLinks: branchLinks.map((branch) => ({ ...branch, anchor: { ...branch.anchor } })),
    })));
    assert.equal(focusedTool.isConnected, true);
    assert.equal(document.activeElement, focusedTool);
    const relocated = branchLinks.map((branch) => branch.id === "text-child"
      ? { ...branch, anchor: { ...branch.anchor, occurrence: 0 } } : branch);
    await act(async () => root.render(React.createElement(MessageContent, { ...props, branchLinks: relocated })));
    assert.match(document.querySelector(".message-text-branch-tools").previousElementSibling.textContent, /第一处/);
    const requoted = relocated.map((branch) => branch.id === "text-child"
      ? { ...branch, quote: "第二处", anchor: { ...branch.anchor, occurrence: 0 } } : branch);
    await act(async () => root.render(React.createElement(MessageContent, { ...props, branchLinks: requoted })));
    assert.match(document.querySelector(".message-text-branch-tools").previousElementSibling.textContent, /第二处/);
    assert.match(document.querySelector(".message-text-branch-tools").textContent, /第二处/);
    const load = document.querySelector("button[data-load-image]");
    await act(async () => load.click());
    let image = document.querySelector("img");
    assert.equal(image.src, "https://images.example.com/diagram.png");
    assert.equal(image.alt, "架构图");
    assert.equal(image.referrerPolicy, "no-referrer");
    await act(async () => image.dispatchEvent(new dom.window.Event("load")));
    assert.equal(load.textContent, "已加载");

    await act(async () => root.render(React.createElement(MessageContent, { ...props, text: `${text}\n\n更新后的内容` })));
    const retry = document.querySelector("button[data-load-image]");
    await act(async () => retry.click());
    image = document.querySelector("img");
    await act(async () => image.dispatchEvent(new dom.window.Event("error")));
    assert.equal(retry.disabled, false);
    assert.match(retry.textContent, /重新加载/);
    assert.equal(document.querySelector("img"), null);
    assert.match(document.querySelector(".message-image-status").textContent, /加载失败/);

    await act(async () => root.render(React.createElement(MessageContent, { text, branchLinks, onOpenBranch: props.onOpenBranch })));
    assert.equal(document.querySelector("button[data-branch-block]"), null);
    assert.equal(document.querySelectorAll("button[data-open-branch]").length, 3);
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(bundleUrl, { force: true });
  }
});
