import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  buildContext,
  createBoard,
  createNode,
  validateWorkspace,
} from "../shared/core.mjs";
import {
  duplicateBoard,
  duplicateSubtree,
  getDescendantIds,
  getVisibleNodes,
  removeBoard,
} from "../shared/operations.mjs";

const message = (id, role, content) => ({
  id,
  role,
  content,
  createdAt: "2026-10-17T00:00:00.000Z",
});
const wrap = (...boards) => ({
  version: 2,
  revision: 31,
  activeBoardId: boards[0].id,
  boards,
});

function fixture() {
  const board = createBoard("探索");
  const root = board.nodes[0];
  root.messages.push(message("root-message", "assistant", "root answer"));
  const branch = createNode(board, {
    parentId: root.id,
    messageId: "root-message",
    quote: "root focus",
    title: "branch",
  });
  branch.messages.push(message("branch-message", "assistant", "branch answer"));
  branch.draft = "draft to retain";
  const nested = createNode(board, {
    parentId: branch.id,
    messageId: "branch-message",
    quote: "branch focus",
    title: "nested",
  });
  nested.messages.push(message("nested-message", "user", "nested question"));
  const sibling = createNode(board, { parentId: root.id });
  const otherRoot = createNode(board);
  return { board, root, branch, nested, sibling, otherRoot };
}

test("subtree copy remaps nested references and preserves its original parent", () => {
  const { board, root, branch, nested } = fixture();
  const input = wrap(board);
  const before = structuredClone(input);
  const { workspace, nodeId } = duplicateSubtree(input, {
    boardId: board.id,
    nodeId: branch.id,
  });
  const output = workspace.boards[0];
  const copied = output.nodes.find((node) => node.id === nodeId);
  const copiedChild = output.nodes.find((node) => node.parentId === nodeId);
  assert.deepEqual(input, before);
  assert.equal(workspace.revision, input.revision);
  assert.equal(output.nodes.length, board.nodes.length + 2);
  assert.notEqual(copied.id, branch.id);
  assert.equal(copied.parentId, root.id);
  assert.deepEqual(copied.source, branch.source);
  assert.equal(copied.draft, branch.draft);
  assert.equal(copied.title, branch.title);
  assert.equal(copied.x, branch.x + 70);
  assert.equal(copied.y, branch.y + 70);
  assert.notEqual(copied.messages[0].id, branch.messages[0].id);
  assert.notEqual(copiedChild.id, nested.id);
  assert.equal(copiedChild.source.messageId, copied.messages[0].id);
  assert.equal(copiedChild.x, nested.x + 70);
  assert.equal(copiedChild.y, nested.y + 70);
  assert.deepEqual(buildContext(output, copiedChild.id), buildContext(board, nested.id));
  validateWorkspace(workspace);
});

test("copied node messages and snapshots are independent of originals and input", () => {
  const { board, branch } = fixture();
  const input = wrap(board);
  const before = structuredClone(input);
  const { workspace, nodeId } = duplicateSubtree(input, {
    boardId: board.id,
    nodeId: branch.id,
  });
  const output = workspace.boards[0];
  const original = output.nodes.find((node) => node.id === branch.id);
  const copy = output.nodes.find((node) => node.id === nodeId);
  const nested = output.nodes.find((node) => node.parentId === nodeId);
  const expected = buildContext(output, nested.id);
  copy.messages[0].content = "changed copy";
  copy.source.context[0].content = "changed copied snapshot";
  copy.source.quote = "changed copied focus";
  assert.equal(original.messages[0].content, "branch answer");
  assert.equal(original.source.context[0].content, "root answer");
  assert.deepEqual(buildContext(output, nested.id), expected);
  original.messages[0].content = "changed original";
  original.source.context[0].content = "changed original snapshot";
  assert.equal(copy.messages[0].content, "changed copy");
  assert.equal(copy.source.context[0].content, "changed copied snapshot");
  assert.deepEqual(input, before);
});

test("copying a root keeps it a root and excludes unrelated roots", () => {
  const { board, root, otherRoot } = fixture();
  const { workspace, nodeId } = duplicateSubtree(wrap(board), {
    boardId: board.id,
    nodeId: root.id,
  });
  const copied = workspace.boards[0].nodes.find((node) => node.id === nodeId);
  assert.equal(copied.parentId, null);
  assert.equal(copied.source, null);
  assert.equal(workspace.boards[0].nodes.length, board.nodes.length * 2 - 1);
  assert.equal(workspace.boards[0].nodes.filter((node) => node.id === otherRoot.id).length, 1);
});

test("board copy allocates all new entity IDs and preserves context and viewport", () => {
  const { board, root, branch, nested } = fixture();
  board.title = "长".repeat(LIMITS.titleLength);
  board.viewport = { x: -250, y: 96, zoom: 0.7 };
  const input = wrap(board, createBoard("other board"));
  const before = structuredClone(input);
  const { workspace, boardId } = duplicateBoard(input, board.id);
  const copy = workspace.boards.find((entry) => entry.id === boardId);
  const oldIds = new Set([
    board.id,
    ...board.nodes.flatMap((node) => [node.id, ...node.messages.map((entry) => entry.id)]),
  ]);
  assert.deepEqual(input, before);
  assert.equal(workspace.revision, input.revision);
  assert.equal(workspace.activeBoardId, boardId);
  assert.equal(workspace.boards[1].id, boardId);
  assert.equal(copy.title.length, LIMITS.titleLength);
  assert.ok(copy.title.endsWith("（副本）"));
  assert.deepEqual(copy.viewport, board.viewport);
  const copyRoot = copy.nodes[board.nodes.indexOf(root)];
  const copyBranch = copy.nodes[board.nodes.indexOf(branch)];
  const copyNested = copy.nodes[board.nodes.indexOf(nested)];
  for (const id of [copy.id, ...copy.nodes.flatMap((node) => [node.id, ...node.messages.map((entry) => entry.id)])])
    assert.ok(!oldIds.has(id));
  assert.equal(copyBranch.parentId, copyRoot.id);
  assert.equal(copyBranch.source.messageId, copyRoot.messages[0].id);
  assert.equal(copyNested.parentId, copyBranch.id);
  assert.equal(copyNested.source.messageId, copyBranch.messages[0].id);
  assert.deepEqual(buildContext(copy, copyBranch.id), buildContext(board, branch.id));
  assert.deepEqual(buildContext(copy, copyNested.id), buildContext(board, nested.id));
  copy.viewport.zoom = 0.5;
  copyBranch.source.context[0].content = "copy change";
  assert.equal(workspace.boards[0].viewport.zoom, 0.7);
  assert.equal(workspace.boards[0].nodes[1].source.context[0].content, "root answer");
  assert.deepEqual(input, before);
});

test("copies preserve historical message references when source messages were deleted", () => {
  const { board, root, branch } = fixture();
  root.messages = [];
  const { workspace, boardId } = duplicateBoard(wrap(board), board.id);
  const copy = workspace.boards.find((entry) => entry.id === boardId);
  assert.equal(copy.nodes[1].source.messageId, branch.source.messageId);
  assert.deepEqual(copy.nodes[1].source.context, branch.source.context);
  validateWorkspace(workspace);
});

test("collapsed nodes remain visible while all descendants are hidden across roots", () => {
  const { board, root, branch, nested, sibling, otherRoot } = fixture();
  const before = structuredClone(board);
  assert.deepEqual(getDescendantIds(board, branch.id), [branch.id, nested.id]);
  assert.deepEqual(getVisibleNodes(board, new Set([branch.id])).map((node) => node.id), [root.id, branch.id, sibling.id, otherRoot.id]);
  assert.deepEqual(getVisibleNodes(board, [root.id, branch.id]).map((node) => node.id), [root.id, otherRoot.id]);
  assert.deepEqual(getVisibleNodes(board, [nested.id, "removed-node"]), board.nodes);
  assert.equal(getVisibleNodes(board, [branch.id])[0], root);
  assert.deepEqual(board, before);
});

test("removing an active board selects the next neighbor or previous last neighbor", () => {
  const boards = [createBoard("first"), createBoard("middle"), createBoard("last")];
  const input = wrap(...boards);
  input.activeBoardId = boards[1].id;
  const before = structuredClone(input);
  const next = removeBoard(input, boards[1].id);
  assert.equal(next.activeBoardId, boards[2].id);
  assert.equal(next.revision, input.revision);
  assert.deepEqual(input, before);
  const previous = removeBoard(next, boards[2].id);
  assert.equal(previous.activeBoardId, boards[0].id);
  const inactiveRemoved = removeBoard(input, boards[0].id);
  assert.equal(inactiveRemoved.activeBoardId, boards[1].id);
});

test("removing the last board creates a blank usable board without changing input", () => {
  const { board } = fixture();
  const input = wrap(board);
  const before = structuredClone(input);
  const output = removeBoard(input, board.id);
  assert.deepEqual(input, before);
  assert.equal(output.revision, input.revision);
  assert.equal(output.boards.length, 1);
  assert.notEqual(output.boards[0].id, board.id);
  assert.equal(output.activeBoardId, output.boards[0].id);
  assert.equal(output.boards[0].nodes.length, 1);
  assert.deepEqual(output.boards[0].nodes[0].messages, []);
  assert.equal(output.boards[0].nodes[0].source, null);
  assert.deepEqual(validateWorkspace(output), output);
});

test("operations reject invalid workspaces and missing targets without changing input", () => {
  const { board } = fixture();
  const input = wrap(board);
  const before = structuredClone(input);
  assert.throws(() => duplicateBoard(input, "missing"), /画布/);
  assert.throws(() => removeBoard(input, "missing"), /画布/);
  assert.throws(() => duplicateSubtree(input, { boardId: board.id, nodeId: "missing" }), /节点/);
  assert.deepEqual(input, before);
  const invalid = structuredClone(input);
  invalid.boards[0].nodes[0].x = Infinity;
  assert.throws(() => duplicateBoard(invalid, board.id), /数值/);
  assert.throws(() => removeBoard(invalid, board.id), /数值/);
  assert.throws(() => duplicateSubtree(invalid, { boardId: board.id, nodeId: board.nodes[0].id }), /数值/);
});

test("duplicated output is validated against workspace and coordinate limits", () => {
  const board = createBoard();
  const root = board.nodes[0];
  root.x = 10000000;
  const input = wrap(board);
  assert.throws(() => duplicateSubtree(input, { boardId: board.id, nodeId: root.id }), /数值/);
  assert.equal(input.boards[0].nodes.length, 1);
  const full = wrap(...Array.from({ length: LIMITS.boards }, (_, index) => createBoard(String(index))));
  assert.throws(() => duplicateBoard(full, full.boards[0].id), /画布列表/);
  assert.equal(full.boards.length, LIMITS.boards);
});
