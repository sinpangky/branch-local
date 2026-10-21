import test from "node:test";
import assert from "node:assert/strict";
import { createBoard, createNode, newId } from "../shared/core.mjs";
import { restoreNodes } from "../shared/history.mjs";

function fixture() {
  const board = createBoard("原画布");
  const root = board.nodes[0];
  root.messages.push({
    id: newId(),
    role: "user",
    content: "共同问题",
    createdAt: new Date().toISOString(),
  });
  const deleted = createNode(board, { parentId: root.id, quote: "共同问题" });
  createNode(board, { parentId: deleted.id, quote: "嵌套探索" });
  const sibling = createNode(board, { parentId: root.id });
  const nodes = structuredClone(
    board.nodes.filter(
      (node) => node.id === deleted.id || node.parentId === deleted.id,
    ),
  );
  board.nodes = board.nodes.filter(
    (node) => !nodes.some((removed) => removed.id === node.id),
  );
  return {
    workspace: {
      version: 2,
      revision: 7,
      activeBoardId: board.id,
      boards: [board],
    },
    board,
    root,
    sibling,
    snapshot: { boardId: board.id, nodes },
  };
}

test("restore retains later sibling messages, drafts, positions, added boards and active board", () => {
  const { workspace, board, sibling, snapshot } = fixture();
  sibling.messages.push({
    id: newId(),
    role: "assistant",
    content: "删除后收到的新回答",
    createdAt: new Date().toISOString(),
  });
  sibling.draft = "删除后输入的草稿";
  sibling.x += 50;
  const added = createBoard("删除后新建的画布");
  workspace.boards.push(added);
  workspace.activeBoardId = added.id;
  const original = structuredClone(workspace);
  const originalSnapshot = structuredClone(snapshot);

  const restored = restoreNodes(workspace, snapshot);

  assert.equal(restored.revision, 7);
  assert.equal(restored.activeBoardId, added.id);
  assert.deepEqual(restored.boards[1], added);
  const restoredBoard = restored.boards.find((entry) => entry.id === board.id);
  assert.deepEqual(
    restoredBoard.nodes.find((node) => node.id === sibling.id),
    sibling,
  );
  assert.deepEqual(
    restoredBoard.nodes.slice(-snapshot.nodes.length),
    snapshot.nodes,
  );
  assert.deepEqual(workspace, original);
  assert.deepEqual(snapshot, originalSnapshot);

  restoredBoard.nodes.at(-1).source.context[0].content = "修改恢复结果";
  restoredBoard.nodes.find((node) => node.id === sibling.id).draft =
    "修改恢复后的草稿";
  assert.deepEqual(workspace, original);
  assert.deepEqual(snapshot, originalSnapshot);
});

test("restoring the same subtree twice rejects duplicate IDs without changing inputs", () => {
  const { workspace, snapshot } = fixture();
  const restored = restoreNodes(workspace, snapshot);
  const before = structuredClone(restored);
  assert.throws(() => restoreNodes(restored, snapshot), /重复/);
  assert.deepEqual(restored, before);
});

test("restore rejects a missing parent and leaves subsequent workspace edits intact", () => {
  const { workspace, board, snapshot } = fixture();
  board.nodes = [];
  const before = structuredClone(workspace);
  assert.throws(() => restoreNodes(workspace, snapshot), /父节点/);
  assert.deepEqual(workspace, before);
});

test("restore rejects a missing original board", () => {
  const { workspace, snapshot } = fixture();
  const replacement = createBoard("另一个画布");
  workspace.boards = [replacement];
  workspace.activeBoardId = replacement.id;
  assert.throws(() => restoreNodes(workspace, snapshot), /原画布/);
});

test("restore rejects a restored message ID that collides with later messages", () => {
  const { workspace, sibling, snapshot } = fixture();
  const restoredMessage = {
    id: newId(),
    role: "user",
    content: "已删除的问题",
    createdAt: new Date().toISOString(),
  };
  snapshot.nodes[0].messages.push(restoredMessage);
  sibling.messages.push({ ...restoredMessage, content: "后续不同的问题" });
  assert.throws(() => restoreNodes(workspace, snapshot), /重复/);
});
