import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  createWorkspace,
  createBoard,
  createNode,
  buildContext,
  validateWorkspace,
  arrangeBoard,
} from "../shared/core.mjs";

const message = (id, role, content) => ({
  id,
  role,
  content,
  createdAt: "2026-10-17T00:00:00.000Z",
});
const wrap = (board) => ({
  version: 2,
  revision: 0,
  activeBoardId: board.id,
  boards: [board],
});
const clone = (value) => JSON.parse(JSON.stringify(value));

test("branch preserves selected message prefix and appends pending focus as user material", () => {
  const board = createBoard();
  const root = board.nodes[0];
  root.messages.push(
    message("m1", "user", "first"),
    message("m2", "assistant", "selected"),
    message("m3", "user", "future"),
  );
  const branch = createNode(board, {
    parentId: root.id,
    messageId: "m2",
    quote: "focus",
  });
  const context = buildContext(board, branch.id);
  assert.deepEqual(context.slice(0, 2), [
    { role: "user", content: "first" },
    { role: "assistant", content: "selected" },
  ]);
  assert.equal(context.length, 3);
  assert.equal(context[2].role, "user");
  assert.match(context[2].content, /focus/);
  assert.ok(!JSON.stringify(context).includes("future"));
});

test("nested snapshots retain ancestor focus and are independent of subsequent parent edits", () => {
  const board = createBoard();
  const root = board.nodes[0];
  root.messages.push(message("a", "assistant", "root answer"));
  const branch = createNode(board, {
    parentId: root.id,
    messageId: "a",
    quote: "first focus",
  });
  branch.messages.push(
    message("b", "user", "branch question"),
    message("c", "assistant", "branch answer"),
    message("d", "user", "not inherited"),
  );
  const nested = createNode(board, {
    parentId: branch.id,
    messageId: "c",
    quote: "second focus",
  });
  const expected = buildContext(board, nested.id);
  root.messages[0].content = "changed root";
  branch.messages[0].content = "changed branch";
  branch.source.context[0].content = "changed snapshot";
  branch.source.quote = "changed focus";
  assert.deepEqual(buildContext(board, nested.id), expected);
  assert.equal(expected.filter((entry) => entry.role === "system").length, 0);
  assert.equal(JSON.stringify(expected).split("first focus").length - 1, 1);
  assert.equal(JSON.stringify(expected).split("second focus").length - 1, 1);
  assert.ok(!JSON.stringify(expected).includes("not inherited"));
  const output = buildContext(board, nested.id);
  output[0].content = "mutated output";
  assert.deepEqual(buildContext(board, nested.id), expected);
});

test("siblings stay independent and omitted messageId captures complete current context", () => {
  const board = createBoard();
  const root = board.nodes[0];
  root.messages.push(
    message("a", "user", "shared"),
    message("b", "assistant", "answer"),
  );
  const left = createNode(board, { parentId: root.id });
  left.messages.push(message("c", "user", "left only"));
  const right = createNode(board, { parentId: root.id });
  assert.deepEqual(buildContext(board, right.id), [
    { role: "user", content: "shared" },
    { role: "assistant", content: "answer" },
  ]);
  assert.throws(
    () => createNode(board, { parentId: root.id, messageId: "missing" }),
    /消息/,
  );
});

test("demo and blank boards roundtrip as normalized independent copies", () => {
  const workspace = createWorkspace();
  assert.equal(workspace.boards[0].nodes.length, 3);
  assert.match(workspace.boards[0].nodes[0].messages[1].content, /尚未调用 AI/);
  const normalized = validateWorkspace(clone(workspace));
  assert.deepEqual(normalized, workspace);
  normalized.boards[0].nodes[0].title = "changed";
  assert.notEqual(
    normalized.boards[0].nodes[0].title,
    workspace.boards[0].nodes[0].title,
  );
  const blank = createBoard();
  assert.equal(blank.nodes[0].messages.length, 0);
  assert.deepEqual(validateWorkspace(wrap(blank)), wrap(blank));
});

test("validation rejects missing parents, cycles, duplicate IDs and invalid roles", () => {
  const workspace = createWorkspace();
  const badParent = clone(workspace);
  badParent.boards[0].nodes[1].parentId = "missing";
  assert.throws(() => validateWorkspace(badParent), /父节点/);
  const cycle = clone(workspace);
  const [root, child] = cycle.boards[0].nodes;
  root.parentId = child.id;
  root.source = { messageId: null, quote: "", context: [] };
  assert.throws(() => validateWorkspace(cycle), /循环/);
  const duplicate = clone(workspace);
  duplicate.boards[0].nodes[1].id = duplicate.boards[0].nodes[0].id;
  assert.throws(() => validateWorkspace(duplicate), /重复/);
  const role = clone(workspace);
  role.boards[0].nodes[0].messages[0].role = "system";
  assert.throws(() => validateWorkspace(role), /角色/);
});

test("validation rejects oversized, nonfinite and malformed payloads", () => {
  const huge = createWorkspace();
  huge.boards[0].nodes[0].draft = "x".repeat(LIMITS.contentLength + 1);
  assert.throws(() => validateWorkspace(huge), /过长/);
  const invalidCoordinate = createWorkspace();
  invalidCoordinate.boards[0].nodes[0].x = Infinity;
  assert.throws(() => validateWorkspace(invalidCoordinate), /数值/);
  const badContext = createWorkspace();
  badContext.boards[0].nodes[1].source.context[0].role = "tool";
  assert.throws(() => validateWorkspace(badContext), /角色/);
  const wrongVersion = createWorkspace();
  wrongVersion.version = 3;
  assert.throws(() => validateWorkspace(wrongVersion), /版本/);
});

test("validation rejects prototype pollution and accessors without evaluating them", () => {
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateWorkspace(polluted), /非法属性/);
  const inherited = Object.create({ version: 1 });
  assert.throws(() => validateWorkspace(inherited), /普通 JSON/);
  const accessor = createWorkspace();
  let called = false;
  Object.defineProperty(accessor, "version", {
    get() {
      called = true;
      return 1;
    },
  });
  assert.throws(() => validateWorkspace(accessor), /访问器/);
  assert.equal(called, false);
});

test("arrange supports multiple roots and places each depth in a separate column", () => {
  const board = createBoard();
  const root = board.nodes[0];
  const child = createNode(board, { parentId: root.id });
  const otherRoot = createNode(board);
  const grandchild = createNode(board, { parentId: child.id });
  assert.equal(arrangeBoard(board), board);
  assert.equal(root.x, otherRoot.x);
  assert.ok(root.x < child.x && child.x < grandchild.x);
  assert.notEqual(root.y, otherRoot.y);
  validateWorkspace(wrap(board));
});
