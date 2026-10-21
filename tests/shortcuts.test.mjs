import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalService } from "../server/service.mjs";
import {
  SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, resolveShortcuts, validateShortcuts,
  shortcutFromEvent, formatShortcut, matchShortcut,
} from "../shared/shortcuts.mjs";

const keyboard = (key, extra = {}) => ({ key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
  ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, ...extra });

test("all 23 registered actions have complete, unique, immutable defaults and correctly scoped edit-sensitive actions", () => {
  assert.equal(SHORTCUT_ACTIONS.length, 23);
  assert.equal(new Set(SHORTCUT_ACTIONS.map(({ id }) => id)).size, 23);
  assert.equal(new Set(Object.values(DEFAULT_SHORTCUTS)).size, 23);
  assert.deepEqual(resolveShortcuts(), DEFAULT_SHORTCUTS);
  assert.equal(DEFAULT_SHORTCUTS.trash, "Delete");
  assert.equal(DEFAULT_SHORTCUTS.rename, "F2");
  assert.equal(DEFAULT_SHORTCUTS.summary, "Ctrl+Shift+R");
  assert.equal(DEFAULT_SHORTCUTS["export-conversation"], "Ctrl+Shift+X");
  for (const action of SHORTCUT_ACTIONS) {
    assert.ok(action.label && action.group);
    assert.ok(["global", "node", "canvas"].includes(action.scope));
    assert.equal(action.defaultBinding, DEFAULT_SHORTCUTS[action.id]);
    assert.equal(Object.isFrozen(action), true);
  }
  assert.equal(SHORTCUT_ACTIONS.find(({ id }) => id === "undo-remove").scope, "canvas");
  assert.equal(SHORTCUT_ACTIONS.find(({ id }) => id === "new-conversation").scope, "global");
  assert.equal(SHORTCUT_ACTIONS.find(({ id }) => id === "focus-composer").scope, "global");
  assert.equal(Object.isFrozen(DEFAULT_SHORTCUTS), true);
  assert.equal(Object.isFrozen(SHORTCUT_ACTIONS), true);
  const copy = resolveShortcuts();
  copy.help = "F3";
  assert.equal(DEFAULT_SHORTCUTS.help, "F1");
});

test("partial shortcut changes canonicalize bindings, preserve prior overrides, support disabling and atomic swaps", () => {
  const first = validateShortcuts({ search: " shift + control + k ", trash: "" });
  assert.equal(first.search, "Ctrl+Shift+K");
  assert.equal(first.trash, "");
  const second = validateShortcuts({ help: "Ctrl+k", settings: "control+," }, first);
  assert.equal(second.search, "Ctrl+Shift+K");
  assert.equal(second.help, "Ctrl+K");
  assert.equal(second.settings, "Ctrl+Comma");
  assert.equal(second.trash, "");
  assert.equal(first.help, "F1");
  const swapped = validateShortcuts({ "new-conversation": "Ctrl+Shift+N", "new-board": "Ctrl+N" });
  assert.equal(swapped["new-conversation"], "Ctrl+Shift+N");
  assert.equal(swapped["new-board"], "Ctrl+N");
  assert.deepEqual(resolveShortcuts({ help: "F3" }), { ...DEFAULT_SHORTCUTS, help: "F3" });
});

test("validation rejects unknown ids, unsafe maps, accessors, conflicts and disallowed system or typing shortcuts", () => {
  for (const input of [null, [], "Ctrl+N", new Map(), { unknown: "F3" }, JSON.parse('{"__proto__":"F3"}'),
    { search: "Ctrl+N" }, { help: "F2" }, { help: null }, { help: 2 }, { help: " " }, { help: "Ctrl++" },
    { help: "Ctrl+Ctrl+P" }, { help: "Ctrl+Shift+Shift+P" }, { help: "Ctrl+P+Q" }, { help: "Ctrl" },
    { help: "N" }, { help: "Shift+N" }, { help: "0" }, { help: "Comma" }, { help: "Backspace" },
    { help: "Ctrl+Alt+P" }, { help: "Meta+P" }, { help: "Win+P" }, { help: "Alt+F4" },
    { help: "Ctrl+Space" }, { help: "Ctrl+Shift+Space" }, { help: "Shift+Delete" },
    { help: "Ctrl+C" }, { help: "Ctrl+V" }, { help: "Ctrl+X" }, { help: "Ctrl+A" },
    { help: "Ctrl+Tab" }, { help: "Ctrl+Escape" }, { help: "Escape" }, { help: "ArrowLeft" },
    { help: "Ctrl+Enter" }, { help: "Ctrl+Shift+Enter" }, { help: "Enter" },
    { help: "Ctrl+ArrowLeft" }, { help: "Home" }, { help: "F13" }, { help: "Ctrl+constructor" },
    { help: "Ctrl+toString" }, { help: "Ctrl+" + "A".repeat(70) }]) {
    assert.throws(() => validateShortcuts(input), Error, JSON.stringify(input));
  }
  let accessed = false;
  const accessor = Object.defineProperty({}, "search", { get() { accessed = true; return "F3"; } });
  assert.throws(() => validateShortcuts(accessor), /访问器/);
  assert.equal(accessed, false);
  assert.throws(() => validateShortcuts({ [Symbol("bad")]: "F3" }), /未知/);
  assert.throws(() => validateShortcuts({ help: "Ctrl+N" }), /已用于.*新建独立会话/);
});

test("event conversion uses physical codes for shifted punctuation and keyboard layouts, and matches exact modifiers", () => {
  assert.equal(shortcutFromEvent(keyboard("n", { ctrlKey: true })), "Ctrl+N");
  assert.equal(shortcutFromEvent(keyboard("N", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+N");
  assert.equal(shortcutFromEvent(keyboard("н", { code: "KeyN", ctrlKey: true })), "Ctrl+N");
  assert.equal(shortcutFromEvent(keyboard(",", { code: "", ctrlKey: true })), "Ctrl+Comma");
  assert.equal(shortcutFromEvent(keyboard("<", { code: "Comma", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+Comma");
  assert.equal(shortcutFromEvent(keyboard("?", { code: "Slash", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+Slash");
  assert.equal(shortcutFromEvent(keyboard("+", { code: "Equal", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+Equal");
  assert.equal(shortcutFromEvent(keyboard(")", { code: "Digit0", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+0");
  assert.equal(shortcutFromEvent(keyboard("F2")), "F2");
  assert.equal(shortcutFromEvent(keyboard("Delete")), "Delete");
  assert.equal(shortcutFromEvent(keyboard("Enter", { ctrlKey: true })), null);
  assert.equal(matchShortcut(keyboard(",", { ctrlKey: true }), "Ctrl+Comma"), true);
  assert.equal(matchShortcut(keyboard("n", { ctrlKey: true }), "Control+n"), true);
  assert.equal(matchShortcut(keyboard("n", { ctrlKey: true, shiftKey: true }), "Ctrl+N"), false);
  assert.equal(matchShortcut(keyboard("n", { ctrlKey: true }), ""), false);
  assert.equal(matchShortcut(keyboard("n", { ctrlKey: true }), "nonsense"), false);
});

test("composition, AltGraph, modifier-only, repeated and reserved key events never form application shortcuts", () => {
  for (const event of [null, {}, keyboard("Control"), keyboard("Shift"), keyboard("Meta"), keyboard("Alt"),
    keyboard("n"), keyboard("N", { shiftKey: true }), keyboard("Escape", { ctrlKey: true }), keyboard("Tab", { ctrlKey: true }),
    keyboard("n", { ctrlKey: true, altKey: true }), keyboard("n", { ctrlKey: true, metaKey: true }),
    keyboard("n", { ctrlKey: true, isComposing: true }), keyboard("n", { ctrlKey: true, keyCode: 229 }),
    keyboard("Process", { ctrlKey: true, code: "KeyN" }), keyboard("Dead", { ctrlKey: true, code: "KeyN" }),
    keyboard("n", { ctrlKey: true, repeat: true }), keyboard("n", { ctrlKey: true, getModifierState: (name) => name === "AltGraph" }),
    keyboard("n", { ctrlKey: true, getModifierState() { throw new Error("unsupported"); } }),
    keyboard("c", { ctrlKey: true }), keyboard("ArrowLeft", { ctrlKey: true }), keyboard(" ", { ctrlKey: true, code: "Space" })])
    assert.equal(shortcutFromEvent(event), null, JSON.stringify(event));
  assert.equal(matchShortcut(keyboard("n", { ctrlKey: true, isComposing: true }), "Ctrl+N"), false);
});

test("human labels render punctuation and disabled shortcuts without exposing canonical key names", () => {
  assert.equal(formatShortcut("Ctrl+Comma"), "Ctrl + ,");
  assert.equal(formatShortcut("Ctrl+Shift+Slash"), "Ctrl + Shift + /");
  assert.equal(formatShortcut("Ctrl+Shift+Delete"), "Ctrl + Shift + Delete");
  assert.equal(formatShortcut("F2"), "F2");
  assert.equal(formatShortcut(""), "未设置");
  assert.equal(formatShortcut("bad combo"), "未设置");
});

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "branch-shortcuts-"));
  const services = [];
  const start = async () => {
    const service = await createLocalService({ dataDir, fetchImpl: async () => { throw new Error("shortcut tests never call a model"); } });
    services.push(service);
    return service;
  };
  t.after(async () => { await Promise.all(services.map((service) => service.close())); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, start };
}

function settings(service, patch) {
  return service.handle(new Request("branch-local://app/api/settings", patch === undefined ? {} : {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  }));
}

test("settings persist complete shortcut maps, merge partial edits and retain independent concurrent changes", async (t) => {
  const { dataDir, start } = await fixture(t);
  const service = await start();
  assert.deepEqual((await (await settings(service)).json()).shortcuts, DEFAULT_SHORTCUTS);
  let response = await settings(service, { shortcuts: { search: "Ctrl+Shift+K", trash: "" } });
  assert.equal(response.status, 200);
  response = await settings(service, { shortcuts: { help: "Ctrl+K" } });
  const map = (await response.json()).shortcuts;
  assert.equal(map.search, "Ctrl+Shift+K");
  assert.equal(map.help, "Ctrl+K");
  assert.equal(map.trash, "");
  assert.equal(Object.keys(map).length, 23);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")).shortcuts, map);
  const restarted = await start();
  assert.deepEqual((await (await settings(restarted)).json()).shortcuts, map);
  const responses = await Promise.all([
    settings(restarted, { shortcuts: { branch: "Ctrl+P" } }),
    settings(restarted, { shortcuts: { merge: "Ctrl+U" } }),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  const merged = (await (await settings(restarted)).json()).shortcuts;
  assert.equal(merged.branch, "Ctrl+P");
  assert.equal(merged.merge, "Ctrl+U");
  assert.equal(merged.search, "Ctrl+Shift+K");
});

test("invalid shortcut updates fail atomically without replacing saved settings or leaking credentials", async (t) => {
  const { dataDir, start } = await fixture(t);
  const service = await start();
  await settings(service, { shortcuts: { search: "Ctrl+Shift+K" }, apiKey: "shortcut-memory-secret", rememberKey: false });
  const before = await readFile(path.join(dataDir, "settings.json"), "utf8");
  for (const shortcuts of [null, [], { missing: "F3" }, { help: "Ctrl+N" }, { help: "Alt+F4" }, { help: "Shift+N" }, { help: 42 }]) {
    const response = await settings(service, { shortcuts, model: "must-not-save" });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /shortcut-memory-secret/);
    assert.equal(await readFile(path.join(dataDir, "settings.json"), "utf8"), before);
  }
  const current = await (await settings(service)).json();
  assert.notEqual(current.model, "must-not-save");
  assert.equal(current.hasApiKey, true);
  assert.equal(current.shortcuts.search, "Ctrl+Shift+K");
  assert.doesNotMatch(before, /shortcut-memory-secret/);
});

test("legacy settings acquire shortcut defaults and partial stored maps normalize on load", async (t) => {
  const { dataDir, start } = await fixture(t);
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ model: "legacy-model", theme: "dark" }));
  const legacy = await start();
  const loaded = await (await settings(legacy)).json();
  assert.deepEqual(loaded.shortcuts, DEFAULT_SHORTCUTS);
  assert.equal(loaded.model, "legacy-model");
  assert.equal(loaded.theme, "dark");
  await legacy.close();
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ shortcuts: { help: "f3", trash: "" } }));
  const partial = await start();
  assert.deepEqual((await (await settings(partial)).json()).shortcuts, { ...DEFAULT_SHORTCUTS, help: "F3", trash: "" });
  await partial.close();
  const bad = JSON.stringify({ shortcuts: { help: "Ctrl+N" } });
  await writeFile(path.join(dataDir, "settings.json"), bad);
  await assert.rejects(() => start(), /设置文件读取失败/);
  assert.equal(await readFile(path.join(dataDir, "settings.json"), "utf8"), bad);
});
