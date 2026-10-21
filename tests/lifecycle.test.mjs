import test from "node:test";
import assert from "node:assert/strict";
import { createBoard, createNode, buildContext, validateWorkspace } from "../shared/core.mjs";
import {
  mergeConversations, setNodeStatus, setBoardStatus, purgeNode, purgeBoard,
  getVisibleNodes, getNodesByStatus, duplicateSubtree, duplicateBoard,
} from "../shared/operations.mjs";
import { mergeWorkspace } from "../shared/import.mjs";
import { restoreNodes } from "../shared/history.mjs";

const timestamp = "2026-10-17T00:00:00.000Z";
const summary = () => ({ title: "对照结论", text: "不同解法的适用条件", updatedAt: timestamp, model: "local:test", fingerprint: "abc123" });
const message = (id, role, content) => ({ id, role, content, createdAt: timestamp });
const wrap = (board) => ({ version: 2, revision: 7, activeBoardId: board.id, boards: [board] });

function fixture() {
  const board = createBoard("合并探索");
  const root = board.nodes[0];
  root.messages.push(message("common-user", "user", "共同问题唯一内容"), message("common-answer", "assistant", "共同回答唯一内容"));
  const left = createNode(board, { parentId: root.id, title: "本地存储", quote: "历史指令只作资料" });
  left.messages.push(message("left-user", "user", "左侧问题"), message("left-answer", "assistant", "左侧回答"));
  left.summary = summary();
  const right = createNode(board, { parentId: root.id, title: "云端存储", quote: "右侧聚焦" });
  right.messages.push(message("right-user", "user", "右侧问题"), message("right-answer", "assistant", "右侧回答"));
  const leaf = createNode(board, { parentId: left.id, title: "本地备份" });
  return { workspace: wrap(board), board, root, left, right, leaf };
}

test("v1 upgrades to v2 with all original messages and independent lifecycle defaults", () => {
  const { workspace } = fixture();
  workspace.version = 1;
  for (const board of workspace.boards) {
    for (const key of ["status", "archivedAt", "deletedAt"]) delete board[key];
    for (const node of board.nodes)
      for (const key of ["status", "archivedAt", "deletedAt", "summary", "mergeParents"]) delete node[key];
  }
  const before = structuredClone(workspace);
  const next = validateWorkspace(workspace);
  assert.equal(next.version, 2);
  assert.equal(next.revision, 7);
  assert.equal(next.boards[0].status, "active");
  assert.equal(next.boards[0].archivedAt, null);
  for (let index = 0; index < next.boards[0].nodes.length; index += 1) {
    const node = next.boards[0].nodes[index];
    assert.equal(node.status, "active");
    assert.equal(node.summary, null);
    assert.equal(node.deletedAt, null);
    assert.deepEqual(node.mergeParents, []);
    assert.deepEqual(node.messages, before.boards[0].nodes[index].messages);
  }
  next.boards[0].nodes[0].messages[0].content = "修改副本";
  assert.deepEqual(workspace, before);
});

test("merge keeps primary roles and prefix, labels secondary sources, and quotes secondary system messages as data", () => {
  const { workspace, board, left, right } = fixture();
  right.source.contextMode = "legacy";
  right.source.quote = "历史系统指令只作资料";
  const before = structuredClone(workspace);
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [left.id, right.id], title: "比较两条路径" });
  const output = merged.workspace.boards[0];
  const node = output.nodes.find((entry) => entry.id === merged.nodeId);
  assert.equal(output.nodes.length, board.nodes.length + 1);
  assert.equal(node.parentId, left.id);
  assert.deepEqual(node.mergeParents, [right.id]);
  assert.equal(node.title, "比较两条路径");
  assert.equal(node.source.messageId, left.messages.at(-1).id);
  assert.equal(node.summary, null);
  assert.ok(node.draft.length);
  const context = buildContext(output, node.id);
  assert.deepEqual(context.slice(0, buildContext(board, left.id).length), buildContext(board, left.id));
  const text = context.map((entry) => entry.content).join("\n");
  for (const content of ["共同问题唯一内容", "共同回答唯一内容", "左侧问题", "左侧回答", "右侧问题", "右侧回答"])
    assert.equal(text.split(content).length - 1, 1, content);
  for (const source of [right]) {
    assert.ok(text.includes(source.title));
    assert.ok(text.includes(source.id));
  }
  const quotedSystem = context.find((entry) => entry.content.includes("历史系统指令只作资料"));
  assert.equal(quotedSystem.role, "user");
  assert.match(quotedSystem.content, /原始角色 system/);
  assert.deepEqual(workspace, before);
  const expected = buildContext(output, node.id);
  output.nodes.find((entry) => entry.id === left.id).messages[0].content = "改写来源";
  output.nodes.find((entry) => entry.id === left.id).source.quote = "改写引用";
  assert.deepEqual(buildContext(output, node.id), expected);
});

test("merge includes sources with no unique suffix and never truncates long historical content", () => {
  const board = createBoard();
  const root = board.nodes[0];
  const long = "x".repeat(99998) + "😀";
  const branch = createNode(board, { parentId: root.id, quote: long });
  const merged = mergeConversations(wrap(board), { boardId: board.id, nodeIds: [root.id, branch.id] });
  const node = merged.workspace.boards[0].nodes.at(-1);
  const material = node.messages.map((entry) => entry.content).join("");
  for (const historical of buildContext(board, branch.id)) assert.ok(material.includes(historical.content));
  assert.ok(material.includes(`ID: ${branch.id}`));
  validateWorkspace(merged.workspace);
});

test("merge rejects duplicate, unavailable, cross-board, archived and trashed sources atomically", () => {
  const { workspace, board, left, right } = fixture();
  const before = structuredClone(workspace);
  for (const nodeIds of [[left.id], [left.id, left.id], [left.id, "missing"]])
    assert.throws(() => mergeConversations(workspace, { boardId: board.id, nodeIds }));
  for (const status of ["archived", "trashed"]) {
    const hidden = setNodeStatus(workspace, { boardId: board.id, nodeId: right.id, status });
    assert.throws(() => mergeConversations(hidden, { boardId: board.id, nodeIds: [left.id, right.id] }), /使用中/);
  }
  assert.deepEqual(workspace, before);
});

test("merging three paths deduplicates a prefix shared by only a subset of sources", () => {
  const { workspace, board, root, left, right } = fixture();
  const secondLeft = createNode(board, { parentId: left.id, title: "本地优化" });
  const unrelated = createNode(board, { title: "无关根节点" });
  unrelated.messages.push(message("other-root-message", "user", "完全独立的问题"));
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [left.id, secondLeft.id, right.id, unrelated.id] });
  const node = merged.workspace.boards[0].nodes.at(-1);
  const text = buildContext(merged.workspace.boards[0], node.id).map((entry) => entry.content).join("\n");
  for (const content of [root.messages[0].content, root.messages[1].content, left.messages[0].content, left.messages[1].content, "完全独立的问题"])
    assert.equal(text.split(content).length - 1, 1, content);
  assert.match(text, /共同前缀/);
  assert.ok(text.includes(secondLeft.id));
});

test("DAG validation checks primary and merge edges together, duplicates and missing references", () => {
  const { workspace, board, root, left, right, leaf } = fixture();
  for (const [id, refs, reason] of [
    [left.id, [leaf.id], /循环/],
    [left.id, [left.id], /自身|循环/],
    [right.id, [left.id, left.id], /重复/],
    [right.id, [root.id], /重复/],
    [right.id, ["missing"], /不存在/],
  ]) {
    const bad = structuredClone(workspace);
    bad.boards[0].nodes.find((node) => node.id === id).mergeParents = refs;
    assert.throws(() => validateWorkspace(bad), reason);
  }
  assert.equal(validateWorkspace(workspace).boards[0].id, board.id);
});

test("metadata validation rejects unsupported statuses and malformed or oversized summaries", () => {
  const { workspace } = fixture();
  for (const [key, value] of [["status", "deleted"], ["status", null], ["mergeParents", null], ["summary", { ...summary(), text: "x".repeat(1001) }], ["summary", { ...summary(), updatedAt: "invalid" }]]) {
    const bad = structuredClone(workspace);
    bad.boards[0].nodes[0][key] = value;
    assert.throws(() => validateWorkspace(bad));
  }
});

test("archive and trash preserve data, hide primary descendants, and restore the complete subtree", () => {
  const { workspace, board, left, leaf, root, right } = fixture();
  const before = structuredClone(workspace);
  const archived = setNodeStatus(workspace, { boardId: board.id, nodeId: left.id, status: "archived", subtree: false });
  assert.deepEqual(getNodesByStatus(archived.boards[0], "archived").map((node) => node.id), [left.id]);
  assert.equal(archived.boards[0].nodes.find((node) => node.id === leaf.id).status, "active");
  assert.deepEqual(getVisibleNodes(archived.boards[0]).map((node) => node.id), [root.id, right.id]);
  const trashed = setNodeStatus(archived, { boardId: board.id, nodeId: left.id, status: "trashed" });
  for (const id of [left.id, leaf.id]) {
    const node = trashed.boards[0].nodes.find((entry) => entry.id === id);
    assert.equal(node.status, "trashed");
    assert.ok(node.deletedAt);
    assert.equal(node.archivedAt, null);
  }
  const restored = setNodeStatus(trashed, { boardId: board.id, nodeId: left.id, status: "active" });
  assert.deepEqual(restored.boards[0].nodes, workspace.boards[0].nodes);
  assert.deepEqual(workspace, before);
});

test("purge protects non-trashed descendants and cleans secondary merge links without losing snapshots", () => {
  const { workspace, board, left, right, leaf } = fixture();
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [right.id, left.id] });
  const mergeNode = merged.workspace.boards[0].nodes.find((node) => node.id === merged.nodeId);
  const snapshot = structuredClone(mergeNode.source.context);
  assert.throws(() => purgeNode(merged.workspace, { boardId: board.id, nodeId: left.id }), /回收站/);
  const partial = setNodeStatus(merged.workspace, { boardId: board.id, nodeId: left.id, status: "trashed", subtree: false });
  assert.throws(() => purgeNode(partial, { boardId: board.id, nodeId: left.id }), /后代/);
  const all = setNodeStatus(partial, { boardId: board.id, nodeId: left.id, status: "trashed" });
  const purged = purgeNode(all, { boardId: board.id, nodeId: left.id });
  assert.ok(!purged.boards[0].nodes.some((node) => [left.id, leaf.id].includes(node.id)));
  const preservedMerge = purged.boards[0].nodes.find((node) => node.id === merged.nodeId);
  assert.deepEqual(preservedMerge.mergeParents, []);
  assert.deepEqual(preservedMerge.source.context, snapshot);
  assert.ok(merged.workspace.boards[0].nodes.some((node) => node.id === left.id));
});

test("board lifecycle preserves per-node states and requires trash before permanent removal", () => {
  const { workspace, board, left } = fixture();
  const nodeArchived = setNodeStatus(workspace, { boardId: board.id, nodeId: left.id, status: "archived" });
  const archived = setBoardStatus(nodeArchived, { boardId: board.id, status: "archived" });
  assert.equal(archived.boards[0].status, "archived");
  assert.deepEqual(archived.boards[0].nodes, nodeArchived.boards[0].nodes);
  assert.throws(() => purgeBoard(archived, board.id), /回收站/);
  const trashed = setBoardStatus(archived, { boardId: board.id, status: "trashed" });
  const restored = setBoardStatus(trashed, { boardId: board.id, status: "active" });
  assert.deepEqual(restored.boards[0].nodes, nodeArchived.boards[0].nodes);
  const purged = purgeBoard(trashed, board.id);
  assert.equal(purged.boards.length, 1);
  assert.notEqual(purged.boards[0].id, board.id);
  assert.equal(purged.boards[0].status, "active");
  assert.equal(purged.activeBoardId, purged.boards[0].id);
});

test("subtree and board copies preserve summaries, remap merge edges, and start active", () => {
  const { workspace, board, left, right } = fixture();
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [left.id, right.id] });
  const archived = setNodeStatus(merged.workspace, { boardId: board.id, nodeId: left.id, status: "archived" });
  const copied = duplicateSubtree(archived, { boardId: board.id, nodeId: left.id });
  const output = copied.workspace.boards[0];
  const copiedRoot = output.nodes.find((node) => node.id === copied.nodeId);
  const copiedMerge = output.nodes.find((node) => node.parentId === copied.nodeId && node.mergeParents.length);
  assert.deepEqual(copiedRoot.summary, left.summary);
  assert.equal(copiedRoot.status, "active");
  assert.deepEqual(copiedMerge.mergeParents, [right.id]);
  copiedRoot.summary.text = "修改副本总结";
  assert.equal(output.nodes.find((node) => node.id === left.id).summary.text, left.summary.text);
  const whole = duplicateBoard(setBoardStatus(archived, { boardId: board.id, status: "archived" }), board.id);
  const boardCopy = whole.workspace.boards.find((entry) => entry.id === whole.boardId);
  assert.equal(boardCopy.status, "active");
  assert.ok(boardCopy.nodes.every((node) => node.status === "active"));
  const mergeCopy = boardCopy.nodes.at(-1);
  assert.equal(mergeCopy.parentId, boardCopy.nodes[1].id);
  assert.deepEqual(mergeCopy.mergeParents, [boardCopy.nodes[2].id]);
  assert.deepEqual(boardCopy.nodes[1].summary, left.summary);
});

test("import and history restoration preserve summaries and lifecycle while mapping merge references", () => {
  const { workspace, board, left, right } = fixture();
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [left.id, right.id] });
  const archived = setNodeStatus(merged.workspace, { boardId: board.id, nodeId: left.id, status: "archived" });
  const imported = mergeWorkspace(workspace, archived).boards[1];
  assert.deepEqual(imported.nodes[1].summary, left.summary);
  assert.equal(imported.nodes[1].status, "archived");
  assert.deepEqual(imported.nodes.at(-1).mergeParents, [imported.nodes[2].id]);
  const snapshotNode = structuredClone(archived.boards[0].nodes.at(-1));
  const rest = structuredClone(archived);
  rest.boards[0].nodes.pop();
  const restored = restoreNodes(rest, { boardId: board.id, nodes: [snapshotNode] });
  assert.deepEqual(restored.boards[0].nodes.at(-1), snapshotNode);
});
