import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

// Compile JSX without bundling another copy of React. Render the real components
// in Node so constructor/name collisions are caught without opening any window.
const bundleUrl = new URL(`../artifacts/test-ui-components-${process.pid}.mjs`, import.meta.url);
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/components/WorkspaceTools.jsx", import.meta.url))],
  outfile: fileURLToPath(bundleUrl),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["react", "react/*", "lucide-react"],
  logLevel: "silent",
});
after(() => rm(bundleUrl, { force: true }));
const { TreeNavigator, MiniMap, DesktopTitlebar } = await import(bundleUrl.href);

const noop = () => {};
const board = {
  id: "test-board",
  nodes: [
    { id: "root", parentId: null, title: "Root discussion", x: 80, y: 100 },
    { id: "branch", parentId: "root", title: "Child discussion", x: 540, y: 100 },
    { id: "nested", parentId: "branch", title: "Nested discussion", x: 1000, y: 100 },
    { id: "sibling", parentId: "root", title: "Sibling discussion", x: 540, y: 440 },
    { id: "other-root", parentId: null, title: "Independent discussion", x: 80, y: 780 },
  ],
};
const renderTree = (collapsed = [], source = board) => renderToStaticMarkup(React.createElement(TreeNavigator, {
  board: source,
  activeId: "nested",
  collapsed,
  onToggle: noop,
  onSelect: noop,
}));

test("TreeNavigator renders a multilevel tree using the native Map constructor", () => {
  const markup = renderTree();
  const titles = ["Root discussion", "Child discussion", "Nested discussion", "Sibling discussion", "Independent discussion"];
  for (const title of titles) assert.ok(markup.includes(title), `Missing tree node: ${title}`);
  assert.equal([...markup.matchAll(/class="tree-row(?: active)?\s*"/g)].length, 5);
  assert.match(markup, /class="tree-row active"[^>]*style="--depth:2"/);
  for (let index = 1; index < titles.length; index += 1) {
    assert.ok(markup.indexOf(titles[index - 1]) < markup.indexOf(titles[index]), "Tree order must follow parent-before-child traversal");
  }
});

test("TreeNavigator hides collapsed descendants while retaining siblings and other roots", () => {
  const branchCollapsed = renderTree(["branch"]);
  for (const title of ["Root discussion", "Child discussion", "Sibling discussion", "Independent discussion"]) {
    assert.ok(branchCollapsed.includes(title));
  }
  assert.ok(!branchCollapsed.includes("Nested discussion"));
  assert.match(branchCollapsed, /aria-expanded="false"/);
  assert.equal([...branchCollapsed.matchAll(/class="tree-row(?: active)?\s*"/g)].length, 4);

  const rootCollapsed = renderTree(["root", "branch"]);
  assert.ok(rootCollapsed.includes("Root discussion"));
  assert.ok(rootCollapsed.includes("Independent discussion"));
  for (const title of ["Child discussion", "Nested discussion", "Sibling discussion"]) {
    assert.ok(!rootCollapsed.includes(title), `Collapsed descendant remains visible: ${title}`);
  }
  assert.equal([...rootCollapsed.matchAll(/class="tree-row(?: active)?\s*"/g)].length, 2);
});

test("TreeNavigator prefers a model summary while preserving the conversation's original title", () => {
  const summarized = structuredClone(board);
  summarized.nodes[0].summary = { title: "Root overview", text: "A distinct branch summary" };
  const markup = renderTree([], summarized);
  assert.equal(summarized.nodes[0].title, "Root discussion");
  assert.match(markup, /title="Root overview · 探索中"/);
  assert.match(markup, /<span>Root overview<\/span>/);
  assert.doesNotMatch(markup, /<span>Root discussion<\/span>/);
});

test("TreeNavigator marks conclusion cards with a shield and adds research status only to their tooltip", () => {
  const researchBoard = structuredClone(board);
  researchBoard.nodes[0].researchStatus = "verify";
  researchBoard.nodes[1].kind = "conclusion"; researchBoard.nodes[1].researchStatus = "adopted";
  researchBoard.nodes[1].merges = [{ nodeId: "root" }];
  const markup = renderTree([], researchBoard);
  assert.match(markup, /title="Root discussion · 待验证"/);
  assert.match(markup, /title="Child discussion · 已采用"/);
  assert.match(markup, /lucide-shield-check/);
  assert.match(markup, /<span>Child discussion<\/span>/);
  assert.doesNotMatch(markup, /<span>Child discussion · 已采用<\/span>/);
});

test("TreeNavigator excludes archived and trashed branches and hides a non-active board", () => {
  const filtered = structuredClone(board);
  filtered.status = "active";
  filtered.nodes[1].status = "archived";
  filtered.nodes[3].status = "trashed";
  const markup = renderTree([], filtered);
  assert.ok(markup.includes("Root discussion"));
  assert.ok(markup.includes("Independent discussion"));
  for (const title of ["Child discussion", "Nested discussion", "Sibling discussion"]) assert.ok(!markup.includes(title));
  assert.equal([...markup.matchAll(/class="tree-row(?: active)?\s*"/g)].length, 2);
  filtered.status = "archived";
  assert.doesNotMatch(renderTree([], filtered), /class="tree-row(?: active)?\s*"/);
});

test("MiniMap renders SVG nodes, edges and the viewport in canvas coordinates", () => {
  const markup = renderToStaticMarkup(React.createElement(MiniMap, {
    nodes: board.nodes,
    viewport: { x: 100, y: 50, zoom: 0.5 },
    stageRef: { current: null },
    activeId: "branch",
    onSelect: noop,
    onPan: noop,
    panelOpen: false,
  }));
  assert.match(markup, /role="img"/);
  assert.match(markup, /viewBox="-280 -180 2160 1560"/);
  assert.equal([...markup.matchAll(/class="minimap-node(?: selected)?\s*"/g)].length, board.nodes.length);
  assert.match(markup, /class="minimap-node selected" x="540" y="100"/);
  assert.match(markup, /d="M 400 224 L 540 224" class="minimap-edge"/);
  assert.match(markup, /class="minimap-viewport" x="-200" y="-100" width="2000" height="1400"/);
  assert.ok(!/NaN|Infinity/.test(markup));
});

test("MiniMap renders no navigation surface for an empty canvas", () => {
  assert.equal(renderToStaticMarkup(React.createElement(MiniMap, {
    nodes: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    stageRef: { current: null },
    onSelect: noop,
    onPan: noop,
  })), "");
});

test("MiniMap uses each card's dimensions for rectangles, edge endpoints, and the canvas bounds", () => {
  const markup = renderToStaticMarkup(React.createElement(MiniMap, {
    nodes: [
      { id: "wide-parent", parentId: null, title: "Wide parent", x: 10, y: 20, width: 600, height: 400 },
      { id: "tall-child", parentId: "wide-parent", title: "Tall child", x: 1000, y: 500, width: 400, height: 600 },
    ],
    viewport: { x: 0, y: 0, zoom: 1 }, stageRef: { current: null },
    activeId: "tall-child", onSelect: noop, onPan: noop, panelOpen: false,
  }));
  assert.match(markup, /class="minimap-node\s*" x="10" y="20" width="600" height="400"/);
  assert.match(markup, /class="minimap-node selected\s*" x="1000" y="500" width="400" height="600"/);
  assert.match(markup, /d="M 610 220 L 1000 800" class="minimap-edge"/);
  assert.match(markup, /viewBox="-80 -80 1560 1260"/);
  assert.ok(!/NaN|Infinity/.test(markup));
});

test("DesktopTitlebar renders nothing when the native bridge is unavailable", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
  try {
    assert.equal(renderToStaticMarkup(React.createElement(DesktopTitlebar, { title: "Test board" })), "");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
});
