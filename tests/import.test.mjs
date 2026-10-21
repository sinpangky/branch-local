import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  createWorkspace,
  createBoard,
  createNode,
  newId,
} from "../shared/core.mjs";
import { mergeWorkspace } from "../shared/import.mjs";

const ids = (workspace) =>
  workspace.boards.flatMap((board) => [
    board.id,
    ...board.nodes.flatMap((node) => [
      node.id,
      ...node.messages.map((message) => message.id),
    ]),
  ]);

test("importing the same workspace creates new IDs and remaps parent/source references", () => {
  const workspace = createWorkspace();
  workspace.revision = 42;
  const before = structuredClone(workspace);
  const merged = mergeWorkspace(workspace, workspace);
  assert.equal(merged.revision, 42);
  assert.equal(merged.boards.length, 2);
  assert.deepEqual(merged.boards[0], workspace.boards[0]);
  const imported = merged.boards[1];
  const originalIds = new Set(ids(workspace));
  const importedIds = ids({ boards: [imported] });
  assert.ok(importedIds.every((id) => !originalIds.has(id)));
  assert.equal(new Set(ids(merged)).size, ids(merged).length);
  assert.equal(merged.activeBoardId, imported.id);
  for (let index = 1; index < imported.nodes.length; index += 1) {
    assert.equal(imported.nodes[index].parentId, imported.nodes[0].id);
    assert.equal(
      imported.nodes[index].source.messageId,
      imported.nodes[0].messages[1].id,
    );
    assert.deepEqual(
      imported.nodes[index].source.context,
      workspace.boards[0].nodes[index].source.context,
    );
  }
  assert.deepEqual(workspace, before);
  imported.nodes[0].messages[0].content = "修改导入后的副本";
  imported.nodes[1].source.context[0].content = "修改导入后的快照";
  assert.deepEqual(workspace, before);
});

test("all incoming boards are copied, first one becomes active, and inputs remain unchanged", () => {
  const current = createWorkspace();
  current.revision = 9;
  current.boards[0].nodes[0].draft = "保留当前草稿";
  const incoming = createWorkspace();
  incoming.boards.push(createBoard("第二张画布"));
  incoming.activeBoardId = incoming.boards[1].id;
  const currentBefore = structuredClone(current),
    incomingBefore = structuredClone(incoming);
  const merged = mergeWorkspace(current, incoming, { suffix: "（冲突副本）" });
  assert.equal(merged.revision, current.revision);
  assert.equal(merged.boards.length, 3);
  assert.deepEqual(merged.boards[0], current.boards[0]);
  assert.equal(merged.activeBoardId, merged.boards[1].id);
  assert.equal(merged.boards[2].title, "第二张画布（冲突副本）");
  assert.deepEqual(current, currentBefore);
  assert.deepEqual(incoming, incomingBefore);
});

test("source IDs without corresponding messages remain historical IDs", () => {
  const current = createWorkspace();
  const incoming = createWorkspace();
  incoming.boards[0].nodes[1].source.messageId = "deleted-message-id";
  const branchWithoutSelection = createNode(incoming.boards[0], {
    parentId: incoming.boards[0].nodes[0].id,
  });
  // Legacy null IDs are historical snapshots and must not be retargeted on import.
  branchWithoutSelection.source.messageId = null;
  branchWithoutSelection.source.contextMode = "legacy";
  assert.equal(branchWithoutSelection.source.messageId, null);
  const merged = mergeWorkspace(current, incoming);
  assert.equal(
    merged.boards[1].nodes[1].source.messageId,
    "deleted-message-id",
  );
  assert.equal(merged.boards[1].nodes.at(-1).source.messageId, null);
});

test("title truncation includes the suffix within the 160 character limit", () => {
  const incoming = createWorkspace();
  incoming.boards[0].title = "长".repeat(LIMITS.titleLength);
  const merged = mergeWorkspace(createWorkspace(), incoming);
  assert.equal(merged.boards[1].title.length, LIMITS.titleLength);
  assert.ok(merged.boards[1].title.endsWith("（导入）"));
});

test("merged limits are checked atomically without changing either input", () => {
  const current = createWorkspace();
  while (current.boards.length < LIMITS.boards)
    current.boards.push(createBoard(`画布 ${current.boards.length}`));
  const incoming = createWorkspace();
  const before = structuredClone(current),
    incomingBefore = structuredClone(incoming);
  assert.throws(() => mergeWorkspace(current, incoming), /数量过大/);
  assert.deepEqual(current, before);
  assert.deepEqual(incoming, incomingBefore);
});

test("both workspace inputs must be valid before merge", () => {
  const invalidCurrent = createWorkspace();
  invalidCurrent.version = 3;
  assert.throws(
    () => mergeWorkspace(invalidCurrent, createWorkspace()),
    /版本/,
  );
  const invalidIncoming = createWorkspace();
  invalidIncoming.boards[0].nodes[0].messages.push({
    id: newId(),
    role: "tool",
    content: "",
    createdAt: new Date().toISOString(),
  });
  assert.throws(
    () => mergeWorkspace(createWorkspace(), invalidIncoming),
    /角色/,
  );
});
