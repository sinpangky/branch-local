import test from "node:test";
import assert from "node:assert/strict";
import { CARD_SIZE, getNodeSize, createBoard, createNode, createWorkspace, validateWorkspace, arrangeBoard } from "../shared/core.mjs";
import { duplicateBoard, duplicateSubtree, mergeConversations } from "../shared/operations.mjs";
import { mergeWorkspace } from "../shared/import.mjs";

const wrap = (board) => ({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] });

test("card dimensions roundtrip independently and missing legacy fields receive defaults", () => {
  const workspace = createWorkspace();
  const nodes = workspace.boards[0].nodes;
  nodes[0].width = 960; nodes[0].height = 800;
  nodes[1].width = 260; nodes[1].height = 220;
  nodes[2].width = 537; nodes[2].height = 409;
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(workspace))), workspace);
  for (const version of [1, 2]) {
    const legacy = structuredClone(workspace);
    legacy.version = version;
    for (const node of legacy.boards[0].nodes) { delete node.width; delete node.height; }
    const upgraded = validateWorkspace(legacy);
    assert.ok(upgraded.boards[0].nodes.every((node) => node.width === 320 && node.height === 248));
    assert.equal(upgraded.version, 2);
    assert.equal(Object.hasOwn(legacy.boards[0].nodes[0], "width"), false);
  }
  assert.deepEqual(getNodeSize(), { width: 320, height: 248 });
  assert.deepEqual(getNodeSize({ width: 500 }), { width: 500, height: 248 });
});

test("card dimension validation rejects nonnumeric, nonfinite and out-of-range values", () => {
  for (const [field, values] of [
    ["width", [null, "500", NaN, Infinity, CARD_SIZE.minWidth - 1, CARD_SIZE.maxWidth + 1]],
    ["height", [null, "300", NaN, Infinity, CARD_SIZE.minHeight - 1, CARD_SIZE.maxHeight + 1]],
  ]) for (const value of values) {
    const workspace = createWorkspace();
    workspace.boards[0].nodes[0][field] = value;
    assert.throws(() => validateWorkspace(workspace), /卡片宽度|卡片高度/);
  }
});

test("new branches leave room for parent width and varying sibling heights", () => {
  const defaultBoard = createBoard();
  const defaultRoot = defaultBoard.nodes[0];
  const first = createNode(defaultBoard, { parentId: defaultRoot.id });
  const second = createNode(defaultBoard, { parentId: defaultRoot.id });
  assert.equal(first.x, defaultRoot.x + 460);
  assert.equal(first.y, defaultRoot.y);
  assert.equal(second.y, first.y + 300);
  const board = createBoard();
  const root = board.nodes[0]; root.width = 960; root.height = 800;
  const wideBranch = createNode(board, { parentId: root.id });
  wideBranch.height = 620;
  const sibling = createNode(board, { parentId: root.id });
  assert.equal(wideBranch.x, root.x + 960 + 140);
  assert.ok(sibling.y >= wideBranch.y + wideBranch.height + 52);
  assert.deepEqual(getNodeSize(sibling), { width: 320, height: 248 });
  assert.deepEqual(getNodeSize(root), { width: 960, height: 800 });
});

test("default card auto-layout remains compatible with the existing tree positions", () => {
  const board = createBoard();
  const root = board.nodes[0];
  const left = createNode(board, { parentId: root.id });
  const right = createNode(board, { parentId: root.id });
  const leaf = createNode(board, { parentId: left.id });
  const other = createNode(board);
  arrangeBoard(board);
  assert.deepEqual([root.x, root.y], [80, 270]);
  assert.deepEqual([left.x, left.y], [540, 100]);
  assert.deepEqual([right.x, right.y], [540, 440]);
  assert.deepEqual([leaf.x, leaf.y], [1000, 100]);
  assert.deepEqual([other.x, other.y], [80, 916]);
});

test("auto-layout separates every irregular card across multiple roots, siblings and depths", () => {
  const board = createBoard();
  const root = board.nodes[0];
  const parents = [root];
  for (let index = 0; index < 24; index += 1) {
    const node = createNode(board, { parentId: index % 7 === 0 ? null : parents[Math.floor(index / 3) % parents.length].id });
    node.width = 260 + (index * 97) % 701;
    node.height = 220 + (index * 131) % 581;
    parents.push(node);
  }
  root.width = 960; root.height = 800;
  const expectedSizes = board.nodes.map(getNodeSize);
  arrangeBoard(board);
  assert.deepEqual(board.nodes.map(getNodeSize), expectedSizes);
  for (let first = 0; first < board.nodes.length; first += 1)
    for (let second = first + 1; second < board.nodes.length; second += 1) {
      const a = board.nodes[first], b = board.nodes[second];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `card ${first} overlaps card ${second}`);
    }
  validateWorkspace(wrap(board));
});

test("subtree copies, board copies and imports preserve each independent card size", () => {
  const workspace = createWorkspace();
  const board = workspace.boards[0];
  board.nodes[0].width = 900; board.nodes[0].height = 740;
  board.nodes[1].width = 410; board.nodes[1].height = 530;
  board.nodes[2].width = 610; board.nodes[2].height = 320;
  const originalSizes = board.nodes.map(getNodeSize);
  const subtree = duplicateSubtree(workspace, { boardId: board.id, nodeId: board.nodes[0].id });
  assert.deepEqual(subtree.workspace.boards[0].nodes.slice(3).map(getNodeSize), originalSizes);
  const copy = duplicateBoard(workspace, board.id);
  assert.deepEqual(copy.workspace.boards[1].nodes.map(getNodeSize), originalSizes);
  const imported = mergeWorkspace(workspace, workspace);
  assert.deepEqual(imported.boards[1].nodes.map(getNodeSize), originalSizes);
  imported.boards[1].nodes[1].width = 800;
  assert.equal(imported.boards[0].nodes[1].width, 410);
  assert.equal(board.nodes[1].width, 410);
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [board.nodes[1].id, board.nodes[2].id] });
  assert.deepEqual(merged.workspace.boards[0].nodes.slice(0, 3).map(getNodeSize), originalSizes);
  assert.deepEqual(getNodeSize(merged.workspace.boards[0].nodes.at(-1)), { width: 320, height: 248 });
});
