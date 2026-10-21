import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalService } from "../server/service.mjs";
import { buildContext, createBoard, createNode, newId, validateWorkspace } from "../shared/core.mjs";
import { mergeConversations } from "../shared/operations.mjs";
import { generateBranchSummary, readSummaryCompletion, summaryFingerprint } from "../server/summaries.mjs";

const timestamp = "2026-10-17T00:00:00.000Z";
const message = (role, content) => ({ id: newId(), role, content, createdAt: timestamp });
const summary = (title, text) => ({ title, text, model: "earlier-model", updatedAt: timestamp, fingerprint: "old" });
const answer = (title = "当前分支的特定结论", text = "当前叶子对完整历史中的具体问题进行了深入比较。") =>
  Response.json({ choices: [{ message: { content: JSON.stringify({ title, summary: text }) } }] });

function branchFixture() {
  const board = createBoard("摘要测试树");
  const root = board.nodes[0];
  root.messages.push(message("user", "ROOT_QUESTION: 如何保存本地数据？"), message("assistant", "ROOT_ANSWER: 比较文件和数据库。"));
  root.summary = summary("数据保存总问题", "研究本地文件和数据库两种方向。");
  const branch = createNode(board, { parentId: root.id, messageId: root.messages[1].id, quote: "本地文件", title: "文件实现" });
  branch.messages.push(message("user", "BRANCH_QUESTION: 文件写入如何原子化？"), message("assistant", "BRANCH_ANSWER: 使用临时文件并 rename。"));
  branch.summary = summary("文件原子写入", "使用临时文件替换目标，避免写入中断丢失数据。");
  const sibling = createNode(board, { parentId: root.id, title: "数据库方向" });
  sibling.messages.push(message("user", "SIBLING_PRIVATE_MESSAGE 不应发送其他分支原文"));
  sibling.summary = summary("SQLite事务研究", "区别于文件方案，采用 SQLite transaction 保证提交一致性。");
  const leaf = createNode(board, { parentId: branch.id, quote: "rename", title: "合并比较" });
  leaf.mergeParents = [sibling.id];
  leaf.messages.push(message("user", "LEAF_QUESTION: 比较 rename 与事务的失败恢复。"), message("assistant", "LEAF_ANSWER: 两条路径都有明确的恢复边界。"));
  const unrelated = createBoard("无关画布");
  unrelated.nodes[0].messages.push(message("user", "DO_NOT_SEND_UNRELATED_BOARD"));
  unrelated.nodes[0].summary = summary("DO_NOT_SEND_UNRELATED_SUMMARY", "DO_NOT_SEND_UNRELATED_SUMMARY");
  const isolated = createNode(board, { title: "无关根节点" });
  isolated.messages.push(message("user", "DO_NOT_SEND_ISOLATED_ROOT"));
  isolated.summary = summary("DO_NOT_SEND_ISOLATED_SUMMARY", "DO_NOT_SEND_ISOLATED_SUMMARY");
  const workspace = validateWorkspace({ version: 2, revision: 0, activeBoardId: board.id, boards: [board, unrelated] });
  return { board: workspace.boards[0], leafId: leaf.id, rootId: root.id, workspace };
}

async function fixture(t, fetchImpl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "branch-summary-"));
  const service = await createLocalService({ dataDir, fetchImpl });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return service;
}

function request(service, pathname, body, { signal, method = "POST", headers } = {}) {
  return service.handle(new Request(`branch-local://app${pathname}`, {
    method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers }, signal,
  }));
}

test("summary uses the selected model and full inherited conversation with distinctive tree context, without saving", async (t) => {
  const calls = [];
  const service = await fixture(t, async (url, options) => { calls.push({ url, options }); return answer(); });
  await request(service, "/api/settings", {
    baseUrl: "https://summary.example.invalid/v1/", model: "configured-model", apiKey: "private-summary-key",
    summaryMaxLength: 80, maxOutputTokens: 1024,
  }, { method: "PUT" });
  const { workspace, board, leafId } = branchFixture();
  const before = await (await service.handle(new Request("branch-local://app/api/workspace"))).json();
  const response = await request(service, "/api/summarize", { workspace, boardId: board.id, nodeId: leafId });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.boardId, board.id);
  assert.equal(result.nodeId, leafId);
  assert.equal(result.summary.model, "configured-model");
  assert.equal(result.summary.fingerprint, summaryFingerprint(board, leafId));
  assert.equal(result.summary.fingerprint.length, 64);
  assert.ok(result.summary.text.length <= 80);
  assert.ok(Number.isFinite(Date.parse(result.summary.updatedAt)));
  const call = calls[0];
  assert.equal(call.url, "https://summary.example.invalid/v1/chat/completions");
  assert.equal(call.options.headers.Authorization, "Bearer private-summary-key");
  const body = JSON.parse(call.options.body);
  assert.equal(body.model, "configured-model");
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 1024);
  const prompt = JSON.stringify(body.messages);
  for (const token of ["ROOT_QUESTION", "ROOT_ANSWER", "BRANCH_QUESTION", "BRANCH_ANSWER", "LEAF_QUESTION", "LEAF_ANSWER",
    "SQLite事务研究", "transaction", "root", "intermediate", "leaf", "mergeParents", "ancestor", "merge-source", "focus", "rename"])
    assert.ok(prompt.includes(token), `missing ${token}`);
  assert.doesNotMatch(prompt, /SIBLING_PRIVATE_MESSAGE|DO_NOT_SEND/);
  assert.deepEqual(await (await service.handle(new Request("branch-local://app/api/workspace"))).json(), before);
});

test("root summaries include sibling distinctions and preserve stable fingerprints when only cards move", async () => {
  const { board, rootId } = branchFixture();
  const calls = [];
  const settings = { model: "test", summaryMaxLength: 160 };
  const result = await generateBranchSummary({ board, nodeId: rootId, settings,
    complete: async (messages) => { calls.push(messages); return '```json\n{"title":"主干保存策略","summary":"从总问题区分文件和数据库方向。"}\n```'; } });
  assert.equal(result.title, "主干保存策略");
  assert.match(JSON.stringify(calls), /root（最初的主干）/);
  const before = summaryFingerprint(board, rootId);
  board.viewport.zoom = 2;
  board.nodes[0].x += 300;
  assert.equal(summaryFingerprint(board, rootId), before);
  board.nodes[0].messages.push(message("user", "新证据"));
  assert.notEqual(summaryFingerprint(board, rootId), before);
});

test("long histories cover every source segment and all partial notes enter a later synthesis level", async () => {
  const board = createBoard("长上下文");
  const root = board.nodes[0];
  const tokens = [];
  for (let index = 0; index < 4; index++) {
    const chunks = Array.from({ length: 5 }, (_, part) => {
      const token = `UNIQUE_MESSAGE_${index}_PART_${part}`;
      tokens.push(token);
      return `${token}\n${"完整上下文材料 ".repeat(1100)}\nEND_${token}`;
    });
    root.messages.push(message(index % 2 ? "assistant" : "user", chunks.join("\n")));
  }
  const prompts = [];
  const intermediate = [];
  const result = await generateBranchSummary({ board, nodeId: root.id, settings: { model: "long", summaryMaxLength: 160 },
    complete: async (messages) => {
      const prompt = messages[1].content;
      prompts.push(prompt);
      if (prompt.includes("生成最终卡片总结")) return '{"title":"完整综合","summary":"完整分段均已进入综合。"}';
      const token = `PARTIAL_NOTE_${prompts.length}_EVIDENCE`;
      intermediate.push({ token, emittedAt: prompts.length - 1 });
      return JSON.stringify({ title: token, summary: `${token}\n${"保留证据与分支差异 ".repeat(500)}` });
    } });
  assert.equal(result.title, "完整综合");
  assert.ok(prompts.length >= 15 && prompts.some((prompt) => prompt.includes("多级综合分组")), "large partial notes require multiple synthesis levels");
  for (const token of tokens) assert.ok(prompts.some((prompt) => prompt.includes(token)), `lost source: ${token}`);
  for (const item of intermediate)
    assert.ok(prompts.slice(item.emittedAt + 1).some((prompt) => prompt.includes(item.token)), `lost note: ${item.token}`);
});

test("long quote and table focus identities stay compact while every original transcript character enters the summary chunks", async () => {
  const table = "| 名称 | 结果 |\n| --- | --- |\n" + Array.from({ length: 900 }, (_, index) =>
    `| UNIQUE_TABLE_ROW_${index} | ${"这一行的独立证据应被保留".repeat(4)} |`,
  ).join("\n");
  for (const focusText of [undefined, "继承快照最后一条消息中的第 1 个表格；首行：名称 | 结果", "独立聚焦提示".repeat(260)]) {
    const board = createBoard("大表格摘要");
    const root = board.nodes[0];
    root.messages.push(message("user", "比较表格中的全部结果"), message("assistant", table));
    const branch = createNode(board, {
      parentId: root.id, quote: table, focusText,
      anchor: { kind: "table", blockIndex: 0, occurrence: 2 },
    });
    branch.messages.push(message("user", "解释中间与末尾行的差异"), message("assistant", "完整比较结论"));
    const originalContext = buildContext(board, branch.id);
    const transcript = originalContext.map((entry, index) =>
      `--- message ${index + 1}/${originalContext.length}; role=${entry.role} ---\n${entry.content}`,
    ).join("\n\n");
    const before = structuredClone(board);
    const prompts = [];
    await generateBranchSummary({ board, nodeId: branch.id, settings: { model: "mock", summaryMaxLength: 160 },
      complete: async (messages) => {
        prompts.push(messages[1].content);
        return '{"title":"完整表格比较","summary":"保留各行证据与当前聚焦。"}';
      } });
    assert.ok(prompts.length > 3, "large source tables must actually take the chunk path");
    for (const prompt of prompts) {
      const identity = JSON.parse(prompt.split("\n")[1]);
      const selectedFocus = focusText ?? table;
      assert.equal(identity.focus, selectedFocus.slice(0, 1200));
      assert.equal(Boolean(identity.focusTruncated), selectedFocus.length > 1200);
      assert.deepEqual(identity.anchor, { kind: "table", blockIndex: 0, occurrence: 2 });
      assert.equal(Object.hasOwn(identity.anchor, "messageText"), false);
      assert.ok(JSON.stringify(identity).length < 2000, "each segment identity must not repeat a full table or captured message");
      if (focusText !== undefined) assert.ok(!identity.focus.includes("UNIQUE_TABLE_ROW_"), "explicit focusText takes priority over quote");
    }
    const sourceParts = prompts.filter((prompt) => prompt.includes("这是完整会话分段 "));
    const restoredTranscript = sourceParts.map((prompt) => prompt.split("\n\n").slice(2).join("\n\n")).join("");
    assert.equal(restoredTranscript, transcript, "all raw transcript chunks must concatenate to the complete original context");
    assert.deepEqual(buildContext(board, branch.id), originalContext, "summary optimization cannot change the chat prefix");
    assert.deepEqual(board, before);
  }
});

test("summary parsing rejects malformed output and sanitizes provider errors", async (t) => {
  let output = Response.json({ choices: [{ message: { content: "This is not JSON" } }] });
  const service = await fixture(t, async () => output);
  const { workspace, board, leafId } = branchFixture();
  const body = { workspace, boardId: board.id, nodeId: leafId };
  const invalid = await request(service, "/api/summarize", body);
  assert.equal(invalid.status, 502);
  assert.match((await invalid.json()).error, /不是有效的 JSON/);
  output = Response.json({ error: { message: "private-provider-error private-key" } }, { status: 401 });
  const failed = await request(service, "/api/summarize", body);
  assert.equal(failed.status, 502);
  assert.match((await failed.clone().json()).error, /HTTP 401/);
  assert.doesNotMatch(await failed.text(), /private-provider-error|private-key/);
  output = Response.json({ choices: [{ message: { content: '{"title":"valid","summary":42}' } }] });
  assert.equal((await request(service, "/api/summarize", body)).status, 502);
});

test("summary endpoint validates workspaces, ids, empty conversations and its 64 MiB limit before model calls", async (t) => {
  let count = 0;
  const service = await fixture(t, async () => { count++; return answer(); });
  assert.equal((await request(service, "/api/summarize", { workspace: {} })).status, 400);
  const board = createBoard();
  const workspace = { version: 2, revision: 0, activeBoardId: board.id, boards: [board] };
  assert.equal((await request(service, "/api/summarize", { workspace, boardId: board.id, nodeId: "missing" })).status, 400);
  assert.equal((await request(service, "/api/summarize", { workspace, boardId: board.id, nodeId: board.nodes[0].id })).status, 400);
  assert.equal((await request(service, "/api/summarize", {}, { headers: { "Content-Length": String(64 * 1024 * 1024 + 1) } })).status, 413);
  assert.equal(count, 0);
});

test("summary jobs are serial and a cancelled queued job never reaches the provider", async (t) => {
  let count = 0;
  let release;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const service = await fixture(t, async () => {
    count++;
    if (count === 1) { started(); await new Promise((resolve) => { release = resolve; }); }
    return answer();
  });
  const { workspace, board, leafId } = branchFixture();
  const body = { workspace, boardId: board.id, nodeId: leafId };
  const first = request(service, "/api/summarize", body);
  await firstStarted;
  const controller = new AbortController();
  const queued = request(service, "/api/summarize", body, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 1);
  controller.abort();
  assert.equal((await queued).status, 502, "queued cancellation returns before the running request finishes");
  release();
  assert.equal((await first).status, 200);
  assert.equal(count, 1);
});

test("summary provider timeouts honour requestTimeoutSeconds and default max_tokens stays omitted", async (t) => {
  let signal;
  let options;
  let started;
  const called = new Promise((resolve) => { started = resolve; });
  const service = await fixture(t, async (_url, input) => { signal = input.signal; options = input; started(); return new Promise(() => {}); });
  await request(service, "/api/settings", { requestTimeoutSeconds: 30 }, { method: "PUT" });
  const { workspace, board, leafId } = branchFixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = request(service, "/api/summarize", { workspace, boardId: board.id, nodeId: leafId });
  await called;
  assert.equal(Object.hasOwn(JSON.parse(options.body), "max_tokens"), false);
  t.mock.timers.tick(29999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  const response = await pending;
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /超时/);
});

test("abort and service close stop active summaries even when provider fetch ignores its signal", async (t) => {
  let activeSignal;
  let started;
  let firstStarted = new Promise((resolve) => { started = resolve; });
  const service = await fixture(t, async (_url, { signal }) => { activeSignal = signal; started(); return new Promise(() => {}); });
  const { workspace, board, leafId } = branchFixture();
  const body = { workspace, boardId: board.id, nodeId: leafId };
  const controller = new AbortController();
  const first = request(service, "/api/summarize", body, { signal: controller.signal });
  await firstStarted;
  controller.abort();
  assert.equal((await first).status, 502);
  assert.equal(activeSignal.aborted, true);
  firstStarted = new Promise((resolve) => { started = resolve; });
  const second = request(service, "/api/summarize", body);
  await firstStarted;
  await service.close();
  assert.equal(activeSignal.aborted, true);
  assert.equal((await second).status, 502);
});

test("SSE summary readers handle split UTF-8, reasoning fields, DONE and sanitized stream errors", async () => {
  const visible = '{"title":"流式总结","summary":"支持兼容服务返回流。"}';
  const data = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "SECRET_REASONING", content: visible.slice(0, 15) } }] })}\r\n\r\n`
    + `data: ${JSON.stringify({ choices: [{ delta: { content: visible.slice(15) } }] })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(data);
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
    }, cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  assert.equal(await readSummaryCompletion(response), visible);
  assert.equal(cancelled, true);
  await assert.rejects(() => readSummaryCompletion(new Response('event: error\ndata: {"error":"SECRET_PROVIDER_DETAIL"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } })), (error) => /返回错误/.test(error.message) && !error.message.includes("SECRET"));
});

function summaryPromptParts(messages) {
  const lines = messages[1].content.split("\n");
  const treeAt = lines.findIndex((line) => line.startsWith("整个所属连通分支结构"));
  const relatedAt = lines.findIndex((line) => line.startsWith("相关分支已有总结"));
  assert.ok(treeAt >= 0 && relatedAt >= 0);
  return { identity: JSON.parse(lines[1]), tree: JSON.parse(lines[treeAt + 1]), related: JSON.parse(lines[relatedAt + 1]), text: messages[1].content };
}

async function inspectSummary(board, nodeId) {
  let request;
  const result = await generateBranchSummary({ board, nodeId, settings: { model: "provenance-test", summaryMaxLength: 160 },
    complete: async (messages) => { request = messages; return '{"title":"区分合并资料","summary":"基于实际合入的历史比较相关方向。"}'; } });
  return { ...summaryPromptParts(request), result };
}

test("append provenance connects independent source trees and their summaries without inventing parents or sending later source messages", async () => {
  const board = createBoard("追加合并的结构");
  const primary = board.nodes[0];
  primary.messages.push(message("user", "PRIMARY_ONLY_QUESTION"), message("assistant", "PRIMARY_ONLY_ANSWER"));
  const source = createNode(board, { title: "独立来源方向" });
  source.messages.push(message("user", "IMPORTED_SOURCE_QUESTION"), message("assistant", "IMPORTED_SOURCE_ANSWER"));
  source.summary = summary("SOURCE_DISTINCT_SUMMARY", "来源的独有研究方向。");
  const sourceChild = createNode(board, { parentId: source.id, title: "来源方向的子分支" });
  sourceChild.summary = summary("SOURCE_CHILD_SUMMARY", "来源子分支的独立发现。");
  const unrelated = createNode(board, { title: "无关根节点" });
  unrelated.messages.push(message("user", "UNRELATED_RAW_MUST_STAY_LOCAL"));
  unrelated.summary = summary("UNRELATED_SUMMARY_MUST_STAY_LOCAL", "无关内容。");
  const workspace = validateWorkspace({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
  const appended = mergeConversations(workspace, { boardId: board.id, nodeIds: [source.id], mode: "append", targetId: primary.id });
  const output = appended.workspace.boards[0];
  const sourceNow = output.nodes.find((node) => node.id === source.id);
  sourceNow.messages.push(message("user", "SOURCE_NEW_RAW_NOT_IMPORTED"));
  const inspected = await inspectSummary(output, primary.id);
  assert.equal(inspected.identity.parentId, null);
  assert.deepEqual(inspected.identity.mergeParents, []);
  assert.equal(inspected.identity.role, "root（最初的主干）");
  assert.equal(inspected.identity.mergeSources[0].nodeId, source.id);
  assert.equal(inspected.identity.mergeSources[0].sourceAvailable, true);
  assert.equal(inspected.identity.mergeSources[0].capturedMessages, 2);
  assert.ok(inspected.identity.mergeSources[0].importedIntoMessageIndexes.every((index) => index >= 3));
  assert.deepEqual(new Set(inspected.tree.map((entry) => entry.id)), new Set([primary.id, source.id, sourceChild.id]));
  assert.equal(inspected.tree.find((entry) => entry.id === source.id).parentId, null);
  const sourceSummary = inspected.related.find((entry) => entry.id === source.id);
  assert.ok(sourceSummary.relation.some((relation) => relation.startsWith("merge-provenance-source")));
  assert.ok(!sourceSummary.relation.some((relation) => /^(ancestor|child|sibling)/.test(relation)));
  assert.ok(inspected.related.some((entry) => entry.title === "SOURCE_CHILD_SUMMARY"));
  assert.match(inspected.text, /IMPORTED_SOURCE_QUESTION/);
  assert.match(inspected.text, /IMPORTED_SOURCE_ANSWER/);
  assert.match(inspected.text, /来源现有总结可能晚于 capturedAt/);
  assert.doesNotMatch(inspected.text, /SOURCE_NEW_RAW_NOT_IMPORTED|UNRELATED_RAW_MUST_STAY_LOCAL|UNRELATED_SUMMARY_MUST_STAY_LOCAL/);
  const before = summaryFingerprint(output, primary.id);
  sourceNow.x += 100;
  sourceNow.width = 640;
  assert.equal(summaryFingerprint(output, primary.id), before);
  sourceNow.summary.text += "来源总结发生变化。";
  assert.notEqual(summaryFingerprint(output, primary.id), before);
});

test("backward and mutual provenance links stay associations and never reverse ancestry or create artificial tree cycles", async () => {
  const board = createBoard("后代回合并到祖先");
  const root = board.nodes[0];
  root.messages.push(message("user", "ROOT_CONTEXT"));
  root.summary = summary("祖先主干", "原始主干问题。");
  const leaf = createNode(board, { parentId: root.id, title: "后代叶子" });
  leaf.messages.push(message("assistant", "LEAF_CONTEXT"));
  leaf.summary = summary("后代发现", "叶子节点的独有发现。");
  const workspace = validateWorkspace({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
  const backward = mergeConversations(workspace, { boardId: board.id, nodeIds: [leaf.id], mode: "append", targetId: root.id });
  const output = backward.workspace.boards[0];
  const inspectedLeaf = await inspectSummary(output, leaf.id);
  assert.equal(inspectedLeaf.identity.role, "leaf（末尾的叶子节点）");
  const ancestor = inspectedLeaf.related.find((entry) => entry.id === root.id);
  assert.ok(ancestor.relation.some((relation) => relation.startsWith("ancestor")));
  assert.ok(ancestor.relation.some((relation) => relation.startsWith("merge-provenance-target")));
  assert.ok(!ancestor.relation.some((relation) => relation.startsWith("child")));
  assert.deepEqual(inspectedLeaf.tree.find((entry) => entry.id === root.id).mergeParents, []);

  const independent = createNode(output, { title: "另一个独立主干" });
  independent.messages.push(message("user", "INDEPENDENT_CONTEXT"));
  independent.summary = summary("另一主干", "互相引用的独立来源。");
  const wrapped = validateWorkspace({ ...backward.workspace, boards: [output] });
  const first = mergeConversations(wrapped, { boardId: board.id, nodeIds: [independent.id], mode: "append", targetId: root.id });
  const mutual = mergeConversations(first.workspace, { boardId: board.id, nodeIds: [root.id], mode: "append", targetId: independent.id });
  const inspected = await inspectSummary(mutual.workspace.boards[0], root.id);
  const related = inspected.related.find((entry) => entry.id === independent.id);
  assert.ok(related.relation.some((relation) => relation.startsWith("merge-provenance-source")));
  assert.ok(related.relation.some((relation) => relation.startsWith("merge-provenance-target")));
  assert.ok(!related.relation.some((relation) => /^(ancestor|child|sibling)/.test(relation)));
  assert.equal(inspected.tree.find((entry) => entry.id === independent.id).role, "root（最初的主干）");
});

test("historical provenance survives a missing source without traversal errors or leaking unused baseline snapshots", async () => {
  const board = createBoard("历史合并记录");
  const root = board.nodes[0];
  root.messages.push(message("user", "当前仍保留的合并资料。"));
  root.merges.push({ nodeId: "purged-source-id", title: "已移除的历史来源", createdAt: timestamp,
    context: [{ role: "user", content: "UNUSED_BASELINE_MUST_NOT_BE_SENT" }], messageIds: ["historical-removed-message"] });
  const workspace = validateWorkspace({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
  const inspected = await inspectSummary(workspace.boards[0], root.id);
  assert.equal(inspected.tree.length, 1);
  assert.equal(inspected.identity.mergeSources[0].sourceAvailable, false);
  assert.equal(inspected.identity.mergeSources[0].title, "已移除的历史来源");
  assert.deepEqual(inspected.identity.mergeSources[0].importedIntoMessageIndexes, []);
  assert.match(inspected.text, /当前仍保留的合并资料/);
  assert.doesNotMatch(inspected.text, /UNUSED_BASELINE_MUST_NOT_BE_SENT/);
});

test("summary relationship background includes research status and conclusion-source associations without importing unrelated raw history", async () => {
  const board = createBoard("研究状态与结论");
  const root = board.nodes[0];
  root.kind = "conclusion";
  root.researchStatus = "adopted";
  root.messages.push(message("assistant", "用户保存的比较结论正文"));
  const related = createNode(board, { title: "结论的来源研究" });
  related.researchStatus = "verify";
  related.messages.push(message("user", "RELATED_RAW_NOT_IMPORTED"));
  related.summary = summary("来源方向", "这个方向仍待独立验证。");
  root.conclusion = { sourceNodeIds: [related.id], items: [], createdAt: timestamp, model: "mock", fingerprint: "old" };
  const inspected = await inspectSummary(board, root.id);
  const entry = inspected.tree.find((node) => node.id === root.id);
  assert.equal(entry.kind, "conclusion"); assert.equal(entry.researchStatus, "adopted");
  assert.deepEqual(entry.conclusionSources, [related.id]);
  assert.equal(inspected.tree.find((node) => node.id === related.id).researchStatus, "verify");
  assert.match(inspected.text, /不能视为模型自动验证/);
  assert.match(inspected.text, /来源方向/);
  assert.doesNotMatch(inspected.text, /RELATED_RAW_NOT_IMPORTED/);
});
