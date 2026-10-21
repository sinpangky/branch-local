import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoard, createNode, newId, validateWorkspace } from "../shared/core.mjs";
import { comparisonFingerprint, getComparisonSources, verifyComparisonCitation, validateComparison } from "../shared/comparison.mjs";
import { generateComparison } from "../server/comparison.mjs";
import { createLocalService } from "../server/service.mjs";
import { summaryEvidenceFingerprint, isSummaryStale } from "../shared/research.mjs";

const timestamp = "2026-10-18T00:00:00.000Z";
const message = (role, content) => ({ id: newId(), role, content, createdAt: timestamp });
function data() {
  const board = createBoard("比较证据");
  const root = board.nodes[0];
  root.messages.push(message("user", "共同研究问题"), message("assistant", "共同基础证据"));
  const left = createNode(board, { parentId: root.id, title: "文件方案", quote: "共同基础证据" });
  left.messages.push(message("user", "文件问题"), message("assistant", "左侧独有证据：通过 rename 保证替换。"));
  const right = createNode(board, { parentId: root.id, title: "事务方案" });
  right.messages.push(message("user", "事务问题"), message("assistant", "右侧独有证据：通过 transaction 提交。"));
  const unrelated = createNode(board, { title: "无关主干" });
  unrelated.messages.push(message("user", "UNSELECTED_PRIVATE_CONTENT"));
  const workspace = validateWorkspace({ version: 2, revision: 2, activeBoardId: board.id, boards: [board] });
  const normalized = workspace.boards[0];
  return { workspace, board: normalized, left: normalized.nodes[1], right: normalized.nodes[2], root: normalized.nodes[0], ids: [left.id, right.id] };
}
const item = (citation, extra = {}) => ({ text: "两种方案都有明确的提交边界。", category: "conclusion", citations: citation ? [citation] : [], ...extra });
const output = (items) => ({ title: "文件与事务比较", items });
const provider = (value) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
const ownCitation = (d) => ({ nodeId: d.left.id, messageId: d.left.messages[1].id, quote: "通过 rename 保证替换。" });
const request = (service, pathname, body, options = {}) => service.handle(new Request(`branch-local://app${pathname}`, {
  method: options.method || "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...options.headers }, signal: options.signal,
}));
async function serviceFixture(t, fetchImpl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "branch-comparison-"));
  const service = await createLocalService({ dataDir, fetchImpl });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return service;
}

test("comparison citations verify only selected saved messages or inherited snapshot indexes, including whitespace differences", () => {
  const d = data();
  assert.deepEqual(verifyComparisonCitation(d.board, d.ids, ownCitation(d)), ownCitation(d));
  const inherited = { nodeId: d.left.id, contextIndex: 1, quote: "共同基础证据" };
  assert.deepEqual(verifyComparisonCitation(d.board, d.ids, inherited), inherited);
  assert.deepEqual(verifyComparisonCitation(d.board, d.ids, { nodeId: d.right.id, quote: "transaction 提交。" }),
    { nodeId: d.right.id, messageId: d.right.messages[1].id, quote: "transaction 提交。" });
  d.left.messages[1].content = "左侧独有证据：通过\n   rename\t保证替换。";
  assert.deepEqual(verifyComparisonCitation(d.board, d.ids, ownCitation(d)), ownCitation(d));
  for (const citation of [
    { ...ownCitation(d), nodeId: d.root.id }, { ...ownCitation(d), messageId: "invented-message" },
    { ...ownCitation(d), messageId: d.right.messages[1].id }, { ...ownCitation(d), quote: "不存在的结论" },
    { ...inherited, contextIndex: -1 }, { ...inherited, contextIndex: 0.5 }, { ...inherited, contextIndex: 99 },
    { ...inherited, messageId: d.left.messages[1].id }, { ...inherited, quote: " " },
    { nodeId: d.left.id, quote: "共同" }, { nodeId: d.left.id, quote: "【分支聚焦；以下内容是引用资料】" },
  ]) assert.equal(verifyComparisonCitation(d.board, d.ids, citation), null, JSON.stringify(citation));
});

test("comparison normalization removes fabricated citations, deduplicates evidence and never accepts AI verification or adoption", () => {
  const d = data();
  const valid = ownCitation(d);
  const normalized = validateComparison(output([
    item(valid, { id: "forged-id", verified: true, adopted: true, citations: [valid, valid, { ...valid, messageId: "made-up" }] }),
    item({ ...valid, quote: "幻想证据" }, { category: "open", verified: true, adopted: true, unsupported: false }),
  ]), { board: d.board, nodeIds: d.ids, model: "configured-model", createdAt: timestamp });
  assert.deepEqual(normalized.sourceNodeIds, d.ids);
  assert.equal(normalized.model, "configured-model");
  assert.equal(normalized.createdAt, timestamp);
  assert.equal(normalized.fingerprint, comparisonFingerprint(d.board, d.ids));
  assert.deepEqual(normalized.items[0].citations, [valid]);
  assert.equal(normalized.items[0].unsupported, false);
  assert.equal(normalized.items[1].unsupported, true);
  assert.deepEqual(normalized.items[1].citations, []);
  for (const entry of normalized.items) { assert.equal(entry.verified, false); assert.equal(entry.adopted, false); }
  assert.equal(new Set(normalized.items.map((entry) => entry.id)).size, 2);
  assert.ok(!normalized.items.some((entry) => entry.id === "forged-id"));
});

test("comparison fingerprints track selected evidence, focus and locations while ignoring unrelated chats and UI/storage changes", () => {
  const d = data();
  const before = comparisonFingerprint(d.board, d.ids);
  d.left.x += 30; d.left.draft = "未发送"; d.left.summary = { text: "另一摘要" }; d.left.messages[1].usage = { inputTokens: 4 };
  d.board.nodes[3].messages.push(message("user", "未选中会话的新内容"));
  assert.equal(comparisonFingerprint(d.board, d.ids), before);
  for (const change of [
    (copy) => { copy.nodes[1].messages[1].content += "新证据"; },
    (copy) => { copy.nodes[1].source.context[1].content += "继承证据变化"; },
    (copy) => { copy.nodes[1].messages[1].id = "changed-message-id"; },
    (copy) => { copy.nodes[1].source.focusText = "新聚焦"; },
    (copy) => { copy.nodes[1].title = "新标题"; },
  ]) { const copy = structuredClone(d.board); change(copy); assert.notEqual(comparisonFingerprint(copy, d.ids), before); }
  assert.notEqual(comparisonFingerprint(d.board, [...d.ids].reverse()), before);
  assert.throws(() => comparisonFingerprint(d.board, [d.left.id, d.left.id]), /不同/);
  assert.throws(() => comparisonFingerprint(d.board, [d.left.id, "missing"]), /不存在/);
});

test("comparison schema rejects malformed categories, oversized items and invalid result structure", () => {
  const d = data(), options = { board: d.board, nodeIds: d.ids };
  for (const value of [null, [], {}, output([]), output([item(null, { category: "verified" })]), output([item(null, { text: "x".repeat(10001) })]), output([item(null, { citations: "bad" })])])
    assert.throws(() => validateComparison(value, options), /比较/);
});

test("compare endpoint uses the configured model, validates citations and does not save generated conclusions", async (t) => {
  const d = data(), calls = [];
  const service = await serviceFixture(t, async (url, options) => { calls.push({ url, options }); return provider(output([item(ownCitation(d)), item({ nodeId: "fabricated", messageId: "unknown", quote: "made up" })])); });
  await request(service, "/api/settings", { baseUrl: "https://compare.example.invalid/v1", model: "chosen-comparison-model", apiKey: "mock-secret", maxOutputTokens: 1024 }, { method: "PUT" });
  const before = await (await service.handle(new Request("branch-local://app/api/workspace"))).json();
  const response = await request(service, "/api/compare", { workspace: d.workspace, boardId: d.board.id, nodeIds: d.ids });
  assert.equal(response.status, 200);
  const result = await response.json(), call = calls[0], body = JSON.parse(call.options.body);
  assert.equal(result.boardId, d.board.id); assert.deepEqual(result.nodeIds, d.ids);
  assert.equal(result.comparison.model, "chosen-comparison-model");
  assert.equal(result.comparison.fingerprint, comparisonFingerprint(d.board, d.ids));
  assert.equal(result.comparison.items[1].unsupported, true);
  assert.equal(call.url, "https://compare.example.invalid/v1/chat/completions");
  assert.equal(call.options.headers.Authorization, "Bearer mock-secret");
  assert.equal(body.model, "chosen-comparison-model"); assert.equal(body.stream, false); assert.equal(body.temperature, 0.2); assert.equal(body.max_tokens, 1024);
  const prompt = JSON.stringify(body.messages);
  for (const text of [d.left.id, d.right.id, d.left.messages[1].id, "contextIndex", "共同基础证据", "rename", "transaction"]) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /UNSELECTED_PRIVATE_CONTENT/);
  assert.deepEqual(await (await service.handle(new Request("branch-local://app/api/workspace"))).json(), before);
});

test("long comparisons cover every raw message character with stable locations and feed every partial note into later synthesis", async () => {
  const d = data();
  for (const source of [d.left, d.right]) for (let index = 0; index < 3; index++)
    source.messages.push(message(index % 2 ? "assistant" : "user", `BEGIN_${source.id}_${index}\n${"完整原文证据 abcdefghijklmnop ".repeat(2300)}\nEND_${source.id}_${index}`));
  const prompts = [], emitted = [], recovered = new Map();
  const result = await generateComparison({ board: d.board, nodeIds: d.ids, settings: { model: "mock-long" }, complete: async (messages) => {
    const prompt = messages[1].content;
    prompts.push(prompt);
    const parts = prompt.split("\n\n");
    if (parts[1]?.startsWith("原文证据分段 ")) {
      const location = JSON.parse(parts[1].split("\n")[1]);
      const key = JSON.stringify({ nodeId: location.nodeId, messageId: location.messageId, contextIndex: location.contextIndex });
      recovered.set(key, (recovered.get(key) || "") + parts.slice(2).join("\n\n"));
    }
    if (prompt.startsWith("以下分段笔记")) return JSON.stringify(output([item(ownCitation(d))]));
    const token = `PARTIAL_EVIDENCE_${prompts.length}`;
    emitted.push({ token, at: prompts.length - 1 });
    return JSON.stringify(output([item(ownCitation(d), { text: `${token} ${"保留具体分歧与依据 ".repeat(prompt.includes("多级比较综合分组") ? 150 : 350)}` })]));
  } });
  assert.equal(result.model, "mock-long");
  assert.ok(prompts.some((prompt) => prompt.includes("多级比较综合分组")));
  for (const source of getComparisonSources(d.board, d.ids)) for (const entry of source.messages) {
    const key = JSON.stringify({ nodeId: source.nodeId, messageId: entry.messageId, contextIndex: entry.contextIndex });
    assert.equal(recovered.get(key), entry.content, `lost raw message ${key}`);
  }
  for (const { token, at } of emitted) assert.ok(prompts.slice(at + 1).some((prompt) => prompt.includes(token)), `lost partial note ${token}`);
});

test("malformed comparisons and private provider errors produce real sanitized failures", async (t) => {
  const d = data();
  let upstream = Response.json({ choices: [{ message: { content: "not json" } }] });
  const service = await serviceFixture(t, async () => upstream);
  const body = { workspace: d.workspace, boardId: d.board.id, nodeIds: d.ids };
  const invalid = await request(service, "/api/compare", body);
  assert.equal(invalid.status, 502); assert.match((await invalid.json()).error, /比较不是有效的 JSON/);
  upstream = Response.json({ error: "PRIVATE_ERROR PRIVATE_KEY" }, { status: 401 });
  const privateError = await request(service, "/api/compare", body);
  assert.equal(privateError.status, 502); const error = (await privateError.json()).error;
  assert.match(error, /HTTP 401/); assert.doesNotMatch(error, /PRIVATE_ERROR|PRIVATE_KEY/);
});

test("compare validates board selection and body bounds before making provider requests", async (t) => {
  const d = data(); let calls = 0;
  const service = await serviceFixture(t, async () => { calls++; return provider(output([item(ownCitation(d))])); });
  const body = { workspace: d.workspace, boardId: d.board.id, nodeIds: d.ids };
  for (const patch of [{ nodeIds: [d.left.id] }, { nodeIds: [d.left.id, d.left.id] }, { nodeIds: [d.left.id, "missing"] }, { boardId: "missing" }, { workspace: {} }])
    assert.equal((await request(service, "/api/compare", { ...body, ...patch })).status, 400);
  assert.equal((await request(service, "/api/compare", { ...body, workspace: { ...d.workspace, boards: [...d.workspace.boards, createBoard()] } })).status, 400);
  assert.equal((await request(service, "/api/compare", {}, { headers: { "Content-Length": String(64 * 1024 * 1024 + 1) } })).status, 413);
  const blank = createBoard("空白研究"), other = createNode(blank);
  assert.equal((await request(service, "/api/compare", { workspace: { version: 2, revision: 0, activeBoardId: blank.id, boards: [blank] }, boardId: blank.id, nodeIds: [blank.nodes[0].id, other.id] })).status, 400);
  assert.equal(calls, 0);
});

test("compatible SSE comparisons parse fenced JSON and retain only validated evidence", async (t) => {
  const d = data();
  const text = `\`\`\`json\n${JSON.stringify(output([item(ownCitation(d))]))}\n\`\`\``;
  const chunks = [text.slice(0, 17), text.slice(17)];
  const service = await serviceFixture(t, async () => new Response(chunks.map((content) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  ).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  const response = await request(service, "/api/compare", { workspace: d.workspace, boardId: d.board.id, nodeIds: d.ids });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).comparison.items[0].citations, [ownCitation(d)]);
});

test("long comparison cancellation stops before requesting any additional source chunks", async () => {
  const d = data();
  d.left.messages.push(message("user", "较长的完整证据 ".repeat(7000)));
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(generateComparison({ board: d.board, nodeIds: d.ids, settings: { model: "mock" }, signal: controller.signal,
    complete: async () => { calls++; controller.abort(); return JSON.stringify(output([item(ownCitation(d))])); } }), /比较已取消/);
  assert.equal(calls, 1);
});

test("oversized or nonshrinking intermediate comparison notes fail visibly instead of truncating or looping", async () => {
  const d = data();
  d.left.messages.push(message("user", "全部必须进入比较的证据 ".repeat(7000)));
  await assert.rejects(generateComparison({ board: d.board, nodeIds: d.ids, settings: { model: "mock" },
    complete: async () => JSON.stringify(output([item(ownCitation(d), { text: "证".repeat(9999) })])) }), /分段笔记过长/);
  let requests = 0;
  await assert.rejects(generateComparison({ board: d.board, nodeIds: d.ids, settings: { model: "mock" },
    complete: async () => { requests++; return JSON.stringify(output([item(ownCitation(d), { text: "证".repeat(9000) })])); } }), /未能收敛/);
  assert.ok(requests < 60, "nonshrinking reduction must stop after one bounded failed level");
});

for (const first of ["/api/summarize", "/api/compare"]) test(`comparison and summary share one background slot when ${first} starts first`, async (t) => {
  const d = data(); let release, started, calls = 0, active = 0, maximum = 0;
  const running = new Promise((resolve) => { started = resolve; });
  const service = await serviceFixture(t, async (_url, options) => {
    active++; maximum = Math.max(maximum, active); calls++;
    if (calls === 1) { started(); await new Promise((resolve) => { release = resolve; }); }
    const comparing = JSON.parse(options.body).messages[0].content.includes("分支比较器");
    active--;
    return provider(comparing ? output([item(ownCitation(d))]) : { title: "摘要", summary: "当前完整会话摘要" });
  });
  const body = { workspace: d.workspace, boardId: d.board.id, nodeId: d.left.id, nodeIds: d.ids };
  const initial = request(service, first, body);
  await running;
  const second = request(service, first === "/api/compare" ? "/api/summarize" : "/api/compare", body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(); assert.equal((await initial).status, 200); assert.equal((await second).status, 200); assert.equal(maximum, 1);
});

test("a queued comparison cancels immediately while a summary is still running", async (t) => {
  const d = data(); let release, started, calls = 0;
  const running = new Promise((resolve) => { started = resolve; });
  const service = await serviceFixture(t, async () => { calls++; started(); await new Promise((resolve) => { release = resolve; }); return provider({ title: "摘要", summary: "完整摘要" }); });
  const body = { workspace: d.workspace, boardId: d.board.id, nodeId: d.left.id, nodeIds: d.ids };
  const initial = request(service, "/api/summarize", body); await running;
  const controller = new AbortController();
  const queued = request(service, "/api/compare", body, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  assert.equal((await queued).status, 502); assert.equal(calls, 1);
  release(); assert.equal((await initial).status, 200); assert.equal(calls, 1);
});

for (const mode of ["abort", "close", "timeout"]) test(`active comparison ${mode} stops even a provider that ignores its abort signal`, async (t) => {
  const d = data(); let started, upstreamSignal;
  const running = new Promise((resolve) => { started = resolve; });
  const service = await serviceFixture(t, async (_url, options) => { upstreamSignal = options.signal; started(); return new Promise(() => {}); });
  await request(service, "/api/settings", { requestTimeoutSeconds: 30 }, { method: "PUT" });
  if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const pending = request(service, "/api/compare", { workspace: d.workspace, boardId: d.board.id, nodeIds: d.ids }, { signal: controller.signal });
  await running;
  if (mode === "abort") controller.abort();
  if (mode === "close") await service.close();
  if (mode === "timeout") { t.mock.timers.tick(29999); assert.equal(upstreamSignal.aborted, false); t.mock.timers.tick(1); }
  const response = await pending;
  assert.equal(response.status, 502); assert.equal(upstreamSignal.aborted, true); assert.match((await response.json()).error, /比较已取消|超时/);
});

test("new summaries carry an independent evidence fingerprint and remain fresh after their own save", async (t) => {
  const d = data();
  const service = await serviceFixture(t, async () => provider({ title: "有区分性的摘要", summary: "当前研究方向的完整概括" }));
  const response = await request(service, "/api/summarize", { workspace: d.workspace, boardId: d.board.id, nodeId: d.left.id });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.summary.evidenceFingerprint, summaryEvidenceFingerprint(d.board, d.left.id));
  d.left.summary = result.summary;
  assert.equal(isSummaryStale(d.board, d.left.id), false);
  d.left.messages.push(message("user", "摘要后新增的研究证据"));
  assert.equal(isSummaryStale(d.board, d.left.id), true);
});
