import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, validateShortcuts, formatShortcut } from "../shared/shortcuts.mjs";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../desktop/main.mjs", import.meta.url));
const virtualRoot = path.join(os.tmpdir(), "branch-shortcut-menu-test-no-files");
// Execute the actual native entry in memory. The instance-lock branch stops startup;
// all Electron, storage and model effects are mocked and no window is ever created.
const source = await readFile(mainFile, "utf8");
const bundle = await build({
  stdin: {
    contents: source + `
      export const shortcutIntegration = {
        installMenu, handleProtocol,
        setup(window, local) { mainWindow = window; service = local; dataDir = ${JSON.stringify(virtualRoot)}; },
        cleanup() { clearTimeout(closeTimer); }
      };
    `,
    resolveDir: path.dirname(mainFile), sourcefile: mainFile, loader: "js",
  },
  bundle: true, platform: "node", format: "cjs", write: false,
  define: { "import.meta.url": JSON.stringify(new URL("../desktop/main.mjs", import.meta.url).href) },
  plugins: [{ name: "mock-native-shortcut-effects", setup(builder) {
    const dependencies = new Map([
      ["electron", "electron"], ["../server/service.mjs", "shortcut-test:service"],
      ["./storage.mjs", "shortcut-test:storage"], ["./migrate.mjs", "shortcut-test:migrate"],
    ]);
    builder.onResolve({ filter: /^(electron|\.\.?\/)/ }, (args) => {
      const dependency = dependencies.get(args.path);
      return dependency ? { path: dependency, external: true } : undefined;
    });
  } }],
});

function flatten(items) {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

function harness(t, { shortcuts = DEFAULT_SHORTCUTS, handle, platform = "win32" } = {}) {
  const menus = [], commands = [], editing = [], effects = [], apiCalls = [];
  let windowCount = 0;
  let fullScreen = false;
  let current = validateShortcuts(shortcuts);
  const webContents = {
    send(channel, command) { commands.push({ channel, command }); },
    ...Object.fromEntries(["undo", "redo", "cut", "copy", "paste", "selectAll", "toggleDevTools"].map((method) =>
      [method, () => editing.push(method)])),
  };
  const mainWindow = {
    webContents, isDestroyed: () => false,
    isFullScreen: () => fullScreen,
    setFullScreen(value) { fullScreen = value; effects.push(["fullScreen", value]); },
    close() { effects.push(["close"]); },
  };
  const local = { async handle(request) {
    const pathname = new URL(request.url).pathname;
    const body = request.method === "PUT" ? await request.json() : undefined;
    apiCalls.push({ method: request.method, pathname, body });
    if (handle) return handle({ request, pathname, body });
    if (pathname === "/api/settings") {
      if (body?.shortcuts !== undefined) {
        try { current = validateShortcuts(body.shortcuts, current); }
        catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
      }
      return Response.json({ model: "native-shortcut-mock", shortcuts: current, fontSize: 16 });
    }
    return Response.json({ ok: true });
  } };
  const electron = {
    app: { getPath: () => virtualRoot, setPath() {}, setAppUserModelId() {}, getVersion: () => "test",
      requestSingleInstanceLock: () => false, quit() {}, isPackaged: false },
    BrowserWindow: class { constructor() { windowCount++; } },
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu: (template) => menus.push(template) },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: {}, clipboard: {}, safeStorage: {}, screen: {},
    shell: { openPath: async (directory) => { effects.push(["openPath", directory]); return ""; } },
    dialog: { showMessageBox: async () => { effects.push(["about"]); } },
  };
  const mocks = {
    electron,
    "shortcut-test:service": { createLocalService: async () => local },
    "shortcut-test:storage": {},
    "shortcut-test:migrate": {},
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", bundle.outputFiles[0].text)(
    (name) => mocks[name] ?? require(name), module, module.exports,
    { platform, argv: [], env: {} },
  );
  const integration = module.exports.shortcutIntegration;
  integration.setup(mainWindow, local);
  t.after(() => { integration.cleanup(); assert.equal(windowCount, 0, "native menu tests must not create a window"); });
  const items = () => flatten(menus.at(-1));
  const commandItems = () => {
    const result = new Map();
    for (const item of items()) {
      if (typeof item.click !== "function") continue;
      const before = commands.length;
      item.click();
      if (commands.length > before) result.set(commands.at(-1).command, item);
    }
    return result;
  };
  return { integration, menus, items, commandItems, commands, editing, effects, apiCalls };
}

function apiRequest(h, method, body, pathname = "/api/settings") {
  return h.integration.handleProtocol(new Request(`branch-local://app${pathname}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  }));
}

test("native menus show every action's current binding without registering any accelerator or implicit editing/fullscreen role", (t) => {
  const h = harness(t);
  h.integration.installMenu();
  assert.equal(h.menus.length, 1);
  const actions = h.commandItems();
  for (const action of SHORTCUT_ACTIONS) {
    assert.ok(actions.has(action.id), `missing native menu action ${action.id}`);
    assert.ok(actions.get(action.id).label.includes(formatShortcut(DEFAULT_SHORTCUTS[action.id])), action.id);
  }
  for (const item of h.items()) {
    assert.equal(Object.hasOwn(item, "accelerator"), false, `native accelerator intercepts renderer keys: ${item.label}`);
    assert.equal(Object.hasOwn(item, "role"), false, `native role may register an implicit accelerator: ${item.label}`);
  }
  const exit = h.items().find((item) => item.label?.startsWith("退出"));
  assert.ok(exit);
  assert.match(exit.label.replace(/\s/g, ""), /Alt\+F4/);
});

test("macOS Command+Q closes through the normal save-before-close path", (t) => {
  const h = harness(t, { platform: "darwin" });
  h.integration.installMenu();
  assert.equal(h.menus.at(-1)[0].label, "枝间");
  const quit = h.items().find((item) => item.accelerator === "Command+Q");
  assert.ok(quit);
  quit.click();
  assert.deepEqual(h.effects.at(-1), ["close"]);
  assert.equal(h.commands.length, 0);
  for (const item of h.commandItems().values()) assert.equal(item.accelerator, undefined);
});

test("rebinding or disabling a shortcut changes only its native label while native clicks keep dispatching the same action", (t) => {
  const h = harness(t);
  h.integration.installMenu({ search: "Ctrl+Shift+K", help: "", branch: "Ctrl+P" });
  const actions = h.commandItems();
  assert.ok(actions.get("search").label.includes(formatShortcut("Ctrl+Shift+K")));
  assert.ok(actions.get("branch").label.includes(formatShortcut("Ctrl+P")));
  assert.ok(!actions.get("help").label.includes("F1"));
  assert.ok(actions.get("settings").label.includes(formatShortcut("Ctrl+Comma")));
  const before = h.commands.length;
  actions.get("help").click();
  assert.deepEqual(h.commands.slice(before), [{ channel: "desktop:command", command: "help" }]);
});

test("plain native editing and fullscreen clicks retain their behavior without swallowing text Ctrl+Z", (t) => {
  const h = harness(t);
  h.integration.installMenu();
  const editMenu = h.menus.at(-1).find((item) => item.label === "编辑");
  const names = [["撤销文本编辑", "undo"], ["重做文本编辑", "redo"], ["剪切", "cut"], ["复制", "copy"], ["粘贴", "paste"], ["全选", "selectAll"]];
  for (const [label, expected] of names) {
    const item = editMenu.submenu.find((entry) => entry.label?.startsWith(label));
    assert.ok(item, label);
    const beforeCommands = h.commands.length;
    item.click();
    assert.equal(h.editing.at(-1), expected);
    assert.equal(h.commands.length, beforeCommands, "text editing must not dispatch a canvas undo action");
    assert.equal(Object.hasOwn(item, "role"), false);
    assert.equal(Object.hasOwn(item, "accelerator"), false);
  }
  const fullscreen = h.items().find((item) => item.label?.startsWith("全屏"));
  fullscreen.click(); fullscreen.click();
  assert.deepEqual(h.effects.slice(-2), [["fullScreen", true], ["fullScreen", false]]);
});

test("successful settings GET and PUT refresh native labels and leave the original response readable", async (t) => {
  const h = harness(t, { shortcuts: { search: "Ctrl+Shift+K" } });
  const initial = await apiRequest(h, "GET");
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).model, "native-shortcut-mock");
  assert.equal(h.menus.length, 1);
  assert.ok(h.commandItems().get("search").label.includes(formatShortcut("Ctrl+Shift+K")));
  const changed = await apiRequest(h, "PUT", { shortcuts: { search: "Ctrl+P" } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).shortcuts.search, "Ctrl+P");
  assert.equal(h.menus.length, 2);
  assert.ok(h.commandItems().get("search").label.includes(formatShortcut("Ctrl+P")));
});

test("failed settings writes and unrelated API requests do not rebuild menus or change their current bindings", async (t) => {
  const h = harness(t);
  await apiRequest(h, "GET");
  const originalMenus = h.menus.length;
  const failed = await apiRequest(h, "PUT", { shortcuts: { search: "Ctrl+N" } });
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /已用于/);
  assert.equal(h.menus.length, originalMenus);
  assert.ok(h.commandItems().get("search").label.includes(formatShortcut("Ctrl+K")));
  assert.equal((await apiRequest(h, "GET", undefined, "/api/health")).status, 200);
  assert.equal(h.menus.length, originalMenus);
});

test("settings menu refresh waits for the successful backend response, never for an optimistic shortcut patch", async (t) => {
  let complete;
  const h = harness(t, { handle: () => new Promise((resolve) => { complete = resolve; }) });
  h.integration.installMenu();
  const pending = apiRequest(h, "PUT", { shortcuts: { search: "Ctrl+P" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.menus.length, 1);
  complete(Response.json({ shortcuts: { ...DEFAULT_SHORTCUTS, search: "Ctrl+P" }, model: "finished" }));
  const response = await pending;
  assert.equal((await response.json()).model, "finished");
  assert.equal(h.menus.length, 2);
  assert.ok(h.commandItems().get("search").label.includes(formatShortcut("Ctrl+P")));
});

for (const delay of ["service response", "cloned JSON body"]) {
  test(`a stale GET delayed in its ${delay} cannot overwrite a newer successful PUT menu`, async (t) => {
    let releaseOld;
    const oldPayload = { model: "old-get", shortcuts: DEFAULT_SHORTCUTS };
    const newPayload = { model: "new-put", shortcuts: { ...DEFAULT_SHORTCUTS, search: "Ctrl+P" } };
    const h = harness(t, { handle: ({ request }) => {
      if (request.method === "PUT") return Response.json(newPayload);
      if (delay === "service response") return new Promise((resolve) => { releaseOld = () => resolve(Response.json(oldPayload)); });
      return new Response(new ReadableStream({ start(controller) {
        releaseOld = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(oldPayload)));
          controller.close();
        };
      } }), { headers: { "Content-Type": "application/json" } });
    } });
    h.integration.installMenu();
    const stale = apiRequest(h, "GET");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof releaseOld, "function");
    assert.equal(h.menus.length, 1);
    const newest = await apiRequest(h, "PUT", { shortcuts: { search: "Ctrl+P" } });
    assert.equal((await newest.json()).model, "new-put");
    assert.equal(h.menus.length, 2);
    releaseOld();
    assert.equal((await (await stale).json()).model, "old-get");
    assert.equal(h.menus.length, 2, "late successful old GET must not rebuild the native menu");
    assert.ok(h.commandItems().get("search").label.includes(formatShortcut("Ctrl+P")));
  });
}
