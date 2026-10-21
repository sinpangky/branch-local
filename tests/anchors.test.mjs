import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { captureTextAnchor, findAnchorRange, focusRenderedAnchor } from "../src/anchors.mjs";

function fixture(t, html) {
  const dom = new JSDOM(`<article class="message assistant"><div class="message-content">${html}</div><div class="message-branch-links">原位置后的分支入口</div><button class="branch-action">从这里分支</button></article>`);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const message = document.querySelector(".message");
  const content = document.querySelector(".message-content");
  const scrolls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolls.push({ target: this, options }); };
  const highlights = new Map();
  Object.defineProperty(dom.window, "CSS", { configurable: true, value: { highlights } });
  dom.window.Highlight = class {
    constructor(...ranges) { this.ranges = ranges; }
  };
  let nextTimer = 0;
  const timers = new Map();
  dom.window.setTimeout = (callback, duration) => { const id = ++nextTimer; timers.set(id, { callback, duration }); return id; };
  dom.window.clearTimeout = (id) => timers.delete(id);
  const range = (startNode, startOffset, endNode, endOffset) => {
    const result = document.createRange();
    result.setStart(startNode, startOffset); result.setEnd(endNode, endOffset);
    return result;
  };
  const runTimer = (id) => { const timer = timers.get(id); assert.ok(timer, `missing timer ${id}`); timers.delete(id); timer.callback(); };
  return { dom, document, message, content, scrolls, highlights, timers, range, runTimer };
}

test("text anchors distinguish repeated phrases across strong/em inline nodes without changing rendered DOM", (t) => {
  const h = fixture(t, '<p id="first">相同<strong>短语</strong>，第一处。</p><p id="second">相同<em>短语</em>，第二处。</p>');
  const first = h.document.querySelector("#first");
  const second = h.document.querySelector("#second");
  const selected = h.range(second.firstChild, 0, second.querySelector("em").firstChild, 2);
  const before = h.content.innerHTML;
  assert.equal(selected.toString(), "相同短语");
  assert.deepEqual(captureTextAnchor(h.content, selected, selected.toString()), { kind: "text", occurrence: 1 });
  const found = findAnchorRange(h.content, "相同短语", 1);
  assert.equal(found.startContainer, second.firstChild);
  assert.equal(found.endContainer, second.querySelector("em").firstChild);
  assert.equal(found.toString(), "相同短语");
  assert.equal(findAnchorRange(h.content, "相同短语", 0).startContainer, first.firstChild);
  assert.equal(h.content.innerHTML, before);
});

test("overlapping occurrences retain the selected offset rather than choosing the first similar phrase", (t) => {
  const h = fixture(t, '<p id="overlap">banana banana</p>');
  const text = h.document.querySelector("#overlap").firstChild;
  for (const [start, occurrence] of [[1, 0], [3, 1], [8, 2], [10, 3]]) {
    const selected = h.range(text, start, text, start + 3);
    assert.equal(selected.toString(), "ana");
    assert.deepEqual(captureTextAnchor(h.content, selected, "ana"), { kind: "text", occurrence });
    const found = findAnchorRange(h.content, "ana", occurrence);
    assert.equal(found.startOffset, start);
    assert.equal(found.endOffset, start + 3);
  }
  assert.equal(findAnchorRange(h.content, "ana", 4), null);
});

test("whitespace-normalized anchors preserve actual range boundaries across inline markup", (t) => {
  const h = fixture(t, '<p>  相 同\n<strong>短\t语</strong>\u00a0结 尾 </p><p id="again">相同短语</p>');
  const found = findAnchorRange(h.content, "相同 短语", 0);
  assert.equal(found.startOffset, 2);
  assert.equal(found.endContainer, h.content.querySelector("strong").firstChild);
  assert.equal(found.endOffset, 3);
  assert.equal(found.toString().replace(/\s/g, ""), "相同短语");
  const second = h.document.querySelector("#again").firstChild;
  const selected = h.range(second, 0, second, 4);
  assert.equal(captureTextAnchor(h.content, selected, "相 同 短 语").occurrence, 1);
  assert.equal(findAnchorRange(h.content, "  \n\t"), null);
  assert.equal(findAnchorRange(h.content, "不存在的引用"), null);
});

test("copy controls, mathml duplicates and block tools do not affect occurrence indexes or mutate source content", (t) => {
  const h = fixture(t, '<button>重复短语</button><span class="katex-mathml">重复短语</span><div class="message-block-tools">重复短语</div><script>重复短语</script><style>.重复短语{}</style><p>重复<strong>短语</strong></p><p id="actual">重复短语</p>');
  const text = h.document.querySelector("#actual").firstChild;
  const selected = h.range(text, 0, text, 4);
  const before = h.content.innerHTML;
  assert.deepEqual(captureTextAnchor(h.content, selected, "重复短语"), { kind: "text", occurrence: 1 });
  const found = findAnchorRange(h.content, "重复短语", 1);
  assert.equal(found.startContainer, text);
  assert.equal(found.toString(), "重复短语");
  assert.equal(findAnchorRange(h.content, "重复短语", 2), null);
  assert.equal(h.content.innerHTML, before);
});

test("table anchors focus exactly the indexed block and missing tables only fall back to the same message", (t) => {
  const h = fixture(t, '<table id="one"><tbody><tr><td>第一表</td></tr></tbody></table><table id="two"><tbody><tr><td>第二表</td></tr></tbody></table>');
  const first = h.document.querySelector("#one");
  const second = h.document.querySelector("#two");
  const focused = focusRenderedAnchor(h.message, { anchor: { kind: "table", blockIndex: 1 } }, { reduceMotion: true });
  assert.equal(focused.precise, true);
  assert.equal(h.scrolls.at(-1).target, second);
  assert.deepEqual(h.scrolls.at(-1).options, { block: "center", behavior: "instant" });
  assert.equal(second.classList.contains("branch-anchor-focus"), true);
  assert.equal(first.classList.contains("branch-anchor-focus"), false);
  focused.clear();
  assert.equal(second.classList.contains("branch-anchor-focus"), false);
  const missing = focusRenderedAnchor(h.message, { anchor: { kind: "table", blockIndex: 9 } });
  assert.equal(missing.precise, false);
  assert.equal(h.scrolls.at(-1).target, h.message);
  assert.equal(first.classList.contains("branch-anchor-focus"), false);
  missing.clear();
});

test("image anchors require the indexed image URL to match and never guess another similar image", (t) => {
  const h = fixture(t, '<figure id="first" data-image-ref="https://images.example/a.png"><img src="https://images.example/a.png"></figure><figure id="second" data-image-ref="https://images.example/b.png"><img src="https://images.example/b.png"></figure>');
  const first = h.document.querySelector("#first");
  const second = h.document.querySelector("#second");
  const exact = focusRenderedAnchor(h.message, { anchor: { kind: "image", blockIndex: 1, imageUrl: "https://images.example/b.png" } });
  assert.equal(exact.precise, true);
  assert.equal(h.scrolls.at(-1).target, second);
  assert.equal(second.classList.contains("branch-anchor-focus"), true);
  exact.clear();
  const mismatch = focusRenderedAnchor(h.message, { anchor: { kind: "image", blockIndex: 1, imageUrl: "https://images.example/a.png" } });
  assert.equal(mismatch.precise, false, "an URL matching a different index must not be treated as a precise hit");
  assert.equal(h.scrolls.at(-1).target, h.message);
  assert.equal(first.classList.contains("branch-anchor-focus"), false);
  assert.equal(second.classList.contains("branch-anchor-focus"), false);
  mismatch.clear();
});

test("after-message anchors focus branch links, with action/message fallbacks when links are unavailable", (t) => {
  const h = fixture(t, "<p>完整回答</p>");
  let result = focusRenderedAnchor(h.message, { anchor: { kind: "after" } });
  assert.equal(result.precise, true);
  assert.equal(h.scrolls.at(-1).target, h.message.querySelector(".message-branch-links"));
  result.clear();
  h.message.querySelector(".message-branch-links").remove();
  result = focusRenderedAnchor(h.message, {});
  assert.equal(h.scrolls.at(-1).target, h.message.querySelector(".branch-action"));
  result.clear();
  h.message.querySelector(".branch-action").remove();
  result = focusRenderedAnchor(h.message, { anchor: { kind: "after" } });
  assert.equal(h.scrolls.at(-1).target, h.message);
  result.clear();
});

test("text focus scrolls to the selected occurrence, registers a CSS Highlight and clears it without rewriting content", (t) => {
  const h = fixture(t, '<p>同一内容</p><p id="selected">同一<strong>内容</strong></p>');
  const paragraph = h.document.querySelector("#selected");
  const before = h.content.textContent;
  const originalText = paragraph.firstChild;
  const originalStrong = paragraph.querySelector("strong");
  const focused = focusRenderedAnchor(h.message, { quote: "同一内容", anchor: { kind: "text", occurrence: 1 } });
  assert.equal(focused.precise, true);
  assert.equal(h.scrolls.at(-1).target, paragraph);
  assert.deepEqual(h.scrolls.at(-1).options, { block: "center", behavior: "smooth" });
  const highlight = h.highlights.get("branch-origin");
  assert.ok(highlight);
  assert.equal(highlight.ranges.length, 1);
  assert.equal(highlight.ranges[0].startContainer, paragraph.firstChild);
  assert.equal(highlight.ranges[0].toString(), "同一内容");
  assert.equal([...h.timers.values()][0].duration, 3500);
  focused.clear();
  assert.equal(h.highlights.has("branch-origin"), false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.content.textContent, before);
  assert.equal(paragraph.firstChild, originalText);
  assert.equal(paragraph.querySelector("strong"), originalStrong);
  assert.equal(paragraph.classList.contains("branch-anchor-focus"), false);
  focused.clear();
  assert.equal(h.content.textContent, before);
});

test("text focus expires naturally and unavailable quotes never highlight a different occurrence", (t) => {
  const h = fixture(t, '<p id="selected">确定存在的引用</p>');
  const focused = focusRenderedAnchor(h.message, { quote: "确定存在", anchor: { kind: "text" } });
  assert.equal(focused.precise, true);
  const timer = [...h.timers.keys()][0];
  h.runTimer(timer);
  assert.equal(h.highlights.has("branch-origin"), false);
  assert.equal(h.document.querySelector("#selected").classList.contains("branch-anchor-focus"), false);
  const missing = focusRenderedAnchor(h.message, { quote: "确定存在", anchor: { kind: "text", occurrence: 3 } });
  assert.equal(missing.precise, false);
  assert.equal(h.scrolls.at(-1).target, h.message);
  assert.equal(h.highlights.has("branch-origin"), false);
  missing.clear();
});

test("clearing an earlier focus cannot remove the newer CSS Highlight or its focus class", (t) => {
  const h = fixture(t, '<p id="selected">第一段与第二段</p>');
  const first = focusRenderedAnchor(h.message, { quote: "第一段", anchor: { kind: "text" } });
  const second = focusRenderedAnchor(h.message, { quote: "第二段", anchor: { kind: "text" } });
  const current = h.highlights.get("branch-origin");
  assert.equal(current.ranges[0].toString(), "第二段");
  first.clear();
  assert.equal(h.highlights.get("branch-origin"), current, "stale cleanup must not clear a newer highlight");
  assert.equal(h.document.querySelector("#selected").classList.contains("branch-anchor-focus"), true);
  second.clear();
  assert.equal(h.highlights.has("branch-origin"), false);
});

test("an old expiry timer cannot clear the highlight of a more recently focused message", (t) => {
  const h = fixture(t, '<p id="first">第一句</p><p id="second">第二句</p>');
  const first = focusRenderedAnchor(h.message, { quote: "第一句", anchor: { kind: "text" } });
  const oldTimer = [...h.timers.keys()][0];
  const second = focusRenderedAnchor(h.message, { quote: "第二句", anchor: { kind: "text" } });
  const current = h.highlights.get("branch-origin");
  // Either cancel the old timer when focusing again, or make its cleanup ownership-aware.
  if (h.timers.has(oldTimer)) h.runTimer(oldTimer);
  assert.equal(h.highlights.get("branch-origin"), current);
  assert.equal(h.document.querySelector("#second").classList.contains("branch-anchor-focus"), true);
  first.clear(); second.clear();
});
