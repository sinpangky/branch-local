import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_LIMITS, AGENT_RUN_STATUSES, AGENT_TOOL_STATUSES,
  validateAgentRun, normalizeAgentRunForLoad,
} from "../shared/agent.mjs";
import { createBoard, createNode, buildContext, validateWorkspace } from "../shared/core.mjs";
import { buildRequestContext } from "../shared/research.mjs";
import { duplicateSubtree, duplicateBoard } from "../shared/operations.mjs";
import { mergeWorkspace } from "../shared/import.mjs";
import { searchConversations } from "../shared/search.mjs";

const startedAt = "2026-10-18T00:00:00.000Z";
const finishedAt = "2026-10-18T00:01:00.000Z";
const clone = (value) => structuredClone(value);
const event = (index = 0) => ({
  id: `call-${index}`, tool: "read_file", status: "completed", summary: "读取资料", detail: "private-tool-trace", at: startedAt,
});
const run = (overrides = {}) => ({
  id: "run-1", engine: "compatible", status: "completed", startedAt, finishedAt, steps: 2,
  events: [event()], artifacts: [{ path: "notes/result.md", kind: "file", summary: "研究结果" }], ...overrides,
});
const wrap = (board) => ({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
function fixture() {
  const board = createBoard("Agent 测试");
  const node = board.nodes[0];
  node.executionMode = "agent";
  node.messages.push(
    { id: "question", role: "user", content: "整理研究结果", createdAt: startedAt },
    { id: "answer", role: "assistant", content: "已整理，结论如下。", createdAt: finishedAt, agentRun: run() },
  );
  return { board, node, workspace: wrap(board) };
}

test("Agent history roundtrips as an independent whitelist copy", () => {
  const input = run();
  input.runtime = { processId: 123, payload: { nested: ["secret"] } };
  input.events[0].arguments = { filename: "secret" };
  input.artifacts[0].downloadHeaders = { Authorization: "secret" };
  const output = validateAgentRun(input);
  assert.deepEqual(output, run());
  output.events[0].detail = "changed";
  output.artifacts[0].path = "other.md";
  assert.equal(input.events[0].detail, "private-tool-trace");
  assert.equal(input.artifacts[0].path, "notes/result.md");
  assert.ok(!JSON.stringify(output).includes("secret"));
});

test("Agent engine IDs and all defined run/tool states are portable", () => {
  for (const status of AGENT_RUN_STATUSES) assert.equal(validateAgentRun(run({ status })).status, status);
  for (const status of AGENT_TOOL_STATUSES) {
    const input = run(); input.events[0].status = status;
    assert.equal(validateAgentRun(input).events[0].status, status);
  }
  assert.equal(validateAgentRun(run({ engine: "other-engine.v2_1" })).engine, "other-engine.v2_1");
});

test("Agent validation rejects malformed identity, status, and step count", () => {
  for (const id of ["", "bad id", "../run", "a".repeat(129), 1]) assert.throws(() => validateAgentRun(run({ id })), /ID/);
  for (const engine of ["", "../engine", "bad engine", "x".repeat(65), {}]) assert.throws(() => validateAgentRun(run({ engine })), /引擎/);
  for (const status of ["done", "", null, 1]) assert.throws(() => validateAgentRun(run({ status })), /状态/);
  for (const steps of [-1, 1.5, Infinity, NaN, "1", AGENT_LIMITS.steps + 1]) assert.throws(() => validateAgentRun(run({ steps })), /步数/);
  assert.equal(validateAgentRun(run({ steps: 0 })).steps, 0);
  assert.equal(validateAgentRun(run({ steps: AGENT_LIMITS.steps })).steps, AGENT_LIMITS.steps);
});

test("Agent history requires bounded arrays and plain JSON records", () => {
  for (const value of [null, [], "history", new Date()]) assert.throws(() => validateAgentRun(value));
  for (const events of [null, {}, new Array(1), Array.from({ length: 61 }, (_, index) => event(index))]) {
    assert.throws(() => validateAgentRun(run({ events })), /工具记录/);
  }
  for (const artifacts of [null, {}, new Array(1), Array.from({ length: 61 }, () => ({ path: "a", kind: "file" }))]) {
    assert.throws(() => validateAgentRun(run({ artifacts })), /产物/);
  }
  const input = run(); input.events[0] = new Date();
  assert.throws(() => validateAgentRun(input), /普通/);
  const accessed = run(); Object.defineProperty(accessed, "status", { get() { throw new Error("accessor ran"); } });
  assert.throws(() => validateAgentRun(accessed), /访问器/);
  const overridden = run(); overridden.events.map = () => [];
  assert.throws(() => validateAgentRun(overridden), /属性/);
});

test("Agent event fields enforce lengths and reject executable or nested values", () => {
  const input = run();
  input.events[0].summary = "s".repeat(500); input.events[0].detail = "d".repeat(12000);
  assert.equal(validateAgentRun(input).events[0].detail.length, 12000);
  for (const [field, value] of [["summary", "s".repeat(501)], ["detail", "d".repeat(12001)], ["summary", {}], ["detail", []], ["detail", "a\0b"], ["tool", ""], ["tool", () => {}], ["status", "waiting"]]) {
    const invalid = run(); invalid.events[0][field] = value;
    assert.throws(() => validateAgentRun(invalid));
  }
  const empty = run(); empty.events[0].summary = ""; empty.events[0].detail = "";
  assert.equal(validateAgentRun(empty).events[0].summary, "");
});

test("Agent artifacts accept both kinds and enforce path/summary bounds", () => {
  const input = run({ artifacts: [{ path: "p".repeat(1024), kind: "download", summary: "s".repeat(500) }] });
  assert.equal(validateAgentRun(input).artifacts[0].kind, "download");
  for (const artifact of [{ path: "", kind: "file" }, { path: "p".repeat(1025), kind: "file" }, { path: "a", kind: "directory" }, { path: "a", kind: "file", summary: "s".repeat(501) }, { path: {}, kind: "file" }]) {
    assert.throws(() => validateAgentRun(run({ artifacts: [artifact] })), /产物/);
  }
});

test("Agent metadata has an aggregate text budget in addition to per-field limits", () => {
  const events = Array.from({ length: AGENT_LIMITS.events }, (_, index) => ({ ...event(index), detail: "" }));
  const artifacts = Array.from({ length: AGENT_LIMITS.artifacts }, () => ({ path: "a", kind: "file" }));
  assert.equal(validateAgentRun(run({ events, artifacts })).events.length, 60);
  for (const item of events) item.detail = "x".repeat(12000);
  assert.throws(() => validateAgentRun(run({ events })), /总量/);
});

test("Agent timestamps normalize ISO offsets and reject invalid dates or reversed completion", () => {
  const input = run({ startedAt: "2026-10-18T08:00:00+08:00" });
  assert.equal(validateAgentRun(input).startedAt, startedAt);
  for (const invalid of ["2026-02-31T00:00:00Z", "2026-10-18", "tomorrow", "2026-10-18T25:00:00Z", 1]) {
    assert.throws(() => validateAgentRun(run({ startedAt: invalid })), /时间/);
  }
  assert.throws(() => validateAgentRun(run({ finishedAt: "2026-10-17T23:59:59Z" })), /早于/);
  assert.equal(validateAgentRun(run({ finishedAt: undefined })).finishedAt, undefined);
});

test("ordinary Agent validation preserves live state; load normalization explicitly interrupts it", () => {
  const input = run({ status: "running", finishedAt: undefined });
  input.events.push({ ...event(1), status: "running" }, { ...event(2), status: "awaiting-approval" });
  assert.equal(validateAgentRun(input).status, "running");
  const loaded = normalizeAgentRunForLoad(input, finishedAt);
  assert.equal(loaded.status, "interrupted");
  assert.equal(loaded.finishedAt, finishedAt);
  assert.deepEqual(loaded.events.map((item) => item.status), ["completed", "cancelled", "cancelled"]);
  assert.equal(input.status, "running");
  assert.equal(input.events[1].status, "running");
  assert.deepEqual(normalizeAgentRunForLoad(run(), finishedAt), run());
});

test("load interruption tolerates a backwards system clock without invalid completion time", () => {
  const input = run({ status: "running", finishedAt: undefined });
  assert.equal(normalizeAgentRunForLoad(input, "2026-10-17T23:00:00Z").finishedAt, startedAt);
  assert.throws(() => normalizeAgentRunForLoad(input, "invalid"), /时间/);
});

test("workspace accepts optional Agent metadata while legacy nodes default to chat", () => {
  const { workspace } = fixture();
  const output = validateWorkspace(clone(workspace));
  assert.equal(output.boards[0].nodes[0].executionMode, "agent");
  assert.deepEqual(output.boards[0].nodes[0].messages[1].agentRun, run());
  delete workspace.boards[0].nodes[0].executionMode;
  assert.equal(validateWorkspace(workspace).boards[0].nodes[0].executionMode, "chat");
  const blank = createBoard();
  assert.equal(blank.nodes[0].executionMode, "chat");
  assert.equal(createNode(blank, { parentId: blank.nodes[0].id }).executionMode, "chat");
});

test("workspace rejects Agent metadata on user messages and unknown execution modes", () => {
  const { workspace } = fixture();
  const userRun = clone(workspace); userRun.boards[0].nodes[0].messages[0].agentRun = run();
  assert.throws(() => validateWorkspace(userRun), /assistant/);
  for (const mode of [null, "other", 1, {}]) {
    const invalid = clone(workspace); invalid.boards[0].nodes[0].executionMode = mode;
    assert.throws(() => validateWorkspace(invalid), /执行模式/);
  }
});

test("historical run and tool IDs may repeat without entering workspace entity identity", () => {
  const { workspace, node } = fixture();
  node.messages.push({ ...clone(node.messages[1]), id: "second-answer" });
  const output = validateWorkspace(workspace);
  assert.equal(output.boards[0].nodes[0].messages[1].agentRun.id, output.boards[0].nodes[0].messages[2].agentRun.id);
});

test("ordinary and branch request contexts exclude Agent traces and artifacts", () => {
  const { board, node } = fixture();
  const expected = [{ role: "user", content: "整理研究结果" }, { role: "assistant", content: "已整理，结论如下。" }];
  assert.deepEqual(buildContext(board, node.id), expected);
  assert.deepEqual(buildRequestContext(board, node.id), expected);
  const branch = createNode(board, { parentId: node.id, messageId: "answer" });
  assert.deepEqual(branch.source.context, expected);
  assert.deepEqual(buildRequestContext(board, branch.id), expected);
  assert.ok(!JSON.stringify(branch.source).includes("private-tool-trace"));
  node.contextPolicy = { mode: "selected", refs: [{ kind: "message", id: "answer" }], conclusionIds: [] };
  assert.deepEqual(buildRequestContext(board, node.id), expected);
  node.contextPolicy = { mode: "conclusions", refs: [], conclusionIds: [] };
  assert.deepEqual(buildRequestContext(board, node.id), expected);
});

test("duplicating a subtree preserves immutable Agent provenance without sharing nested records", () => {
  const { board, node, workspace } = fixture();
  const output = duplicateSubtree(workspace, { boardId: board.id, nodeId: node.id });
  const duplicate = output.workspace.boards[0].nodes.find((entry) => entry.id === output.nodeId);
  assert.equal(duplicate.executionMode, "agent");
  assert.notEqual(duplicate.messages[1].id, "answer");
  assert.deepEqual(duplicate.messages[1].agentRun, run());
  duplicate.messages[1].agentRun.events[0].detail = "copy changed";
  duplicate.messages[1].agentRun.artifacts[0].path = "copy.md";
  assert.equal(output.workspace.boards[0].nodes[0].messages[1].agentRun.events[0].detail, "private-tool-trace");
  assert.equal(workspace.boards[0].nodes[0].messages[1].agentRun.artifacts[0].path, "notes/result.md");
});

test("import remaps conversation IDs while retaining independent historical Agent records", () => {
  const { workspace } = fixture();
  const destination = wrap(createBoard("Destination"));
  const imported = mergeWorkspace(destination, workspace);
  const importedNode = imported.boards[1].nodes[0];
  assert.notEqual(importedNode.messages[1].id, "answer");
  assert.deepEqual(importedNode.messages[1].agentRun, run());
  importedNode.messages[1].agentRun.events[0].detail = "import changed";
  assert.equal(workspace.boards[0].nodes[0].messages[1].agentRun.events[0].detail, "private-tool-trace");
});

test("duplicating a board deep copies Agent history while preserving its historical IDs", () => {
  const { workspace, board } = fixture();
  const output = duplicateBoard(workspace, board.id);
  const duplicate = output.workspace.boards.find((entry) => entry.id === output.boardId).nodes[0];
  assert.equal(duplicate.executionMode, "agent");
  assert.notEqual(duplicate.messages[1].id, "answer");
  assert.deepEqual(duplicate.messages[1].agentRun, run());
  duplicate.messages[1].agentRun.events[0].summary = "copy changed";
  duplicate.messages[1].agentRun.artifacts[0].path = "copy.md";
  assert.equal(output.workspace.boards[0].nodes[0].messages[1].agentRun.events[0].summary, "读取资料");
  assert.equal(workspace.boards[0].nodes[0].messages[1].agentRun.artifacts[0].path, "notes/result.md");
});

test("copies interrupt only copied live runs and cannot carry pending approvals or a resumable process", () => {
  const { workspace, board, node } = fixture();
  const live = node.messages[1].agentRun;
  live.status = "running"; delete live.finishedAt;
  live.events.push({ ...event(1), status: "running" }, { ...event(2), status: "awaiting-approval" });
  const subtree = duplicateSubtree(workspace, { boardId: board.id, nodeId: node.id });
  const copiedNode = subtree.workspace.boards[0].nodes.find((entry) => entry.id === subtree.nodeId);
  const copiedRun = copiedNode.messages[1].agentRun;
  assert.equal(copiedRun.status, "interrupted");
  assert.ok(copiedRun.finishedAt >= copiedRun.startedAt);
  assert.deepEqual(copiedRun.events.map((entry) => entry.status), ["completed", "cancelled", "cancelled"]);
  assert.equal(subtree.workspace.boards[0].nodes[0].messages[1].agentRun.status, "running");
  assert.equal(subtree.workspace.boards[0].nodes[0].messages[1].agentRun.events[2].status, "awaiting-approval");
  const boardCopy = duplicateBoard(workspace, board.id);
  const copiedBoard = boardCopy.workspace.boards.find((entry) => entry.id === boardCopy.boardId);
  assert.equal(copiedBoard.nodes[0].messages[1].agentRun.status, "interrupted");
  assert.equal(boardCopy.workspace.boards[0].nodes[0].messages[1].agentRun.status, "running");
  assert.equal(live.status, "running"); assert.equal(live.finishedAt, undefined);
  assert.equal(live.events[1].status, "running"); assert.equal(live.events[2].status, "awaiting-approval");
});

test("conversation search indexes visible Agent replies without private execution traces", () => {
  const { workspace } = fixture();
  assert.equal(searchConversations(workspace, "已整理").length, 1);
  assert.equal(searchConversations(workspace, "private-tool-trace").length, 0);
  assert.equal(searchConversations(workspace, "notes/result.md").length, 0);
});
