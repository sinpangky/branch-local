import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../desktop/main.mjs", import.meta.url));
const virtualRoot = path.join(os.tmpdir(), "branch-desktop-main-test-no-files");
// Build an in-memory test entry. Electron and storage/model effects are mocked;
// no application window, service listener or filesystem mutation is performed.
const source = await readFile(mainFile, "utf8");
const bundle = await build({
  stdin: {
    contents: source + `
      export const integration = {
        installIPC, handleProtocol, requestClose, createService,
        setup(window, local, directory) { mainWindow = window; service = local; dataDir = directory; },
        pageLoaded() { pageReady = true; finishStorageReload(); },
        state() { return { service, dataDir, changingStorage, storageReloadPending, closePending }; },
        cleanup() { clearTimeout(closeTimer); }
      };
    `,
    resolveDir: path.dirname(mainFile),
    sourcefile: mainFile,
    loader: "js",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  define: { "import.meta.url": JSON.stringify(new URL("../desktop/main.mjs", import.meta.url).href) },
  plugins: [{
    name: "mock-desktop-effects",
    setup(builder) {
      const dependencies = new Map([
        ["electron", "electron"],
        ["../server/service.mjs", "desktop-test:service"],
        ["./storage.mjs", "desktop-test:storage"],
        ["./migrate.mjs", "desktop-test:migrate"],
      ]);
      builder.onResolve({ filter: /^(electron|\.\.?\/)/ }, (args) => {
        const dependency = dependencies.get(args.path);
        return dependency ? { path: dependency, external: true } : undefined;
      });
    },
  }],
});

function harness(t, { prepare, commit, create, selfTest = false, platform = process.platform,
  encryptionAvailable = true, storageBackend = "gnome_libsecret" } = {}) {
  const calls = [], sent = [], handlers = new Map(), listeners = new Map();
  let windowCount = 0;
  const sourceDir = path.join(virtualRoot, "source");
  const targetDir = path.join(virtualRoot, "target");
  const localService = (directory) => ({
    directory,
    async handle(request) {
      calls.push({ action: "api", directory, pathname: new URL(request.url).pathname,
        body: request.method === "PUT" ? await request.json() : null });
      return Response.json({ ok: true });
    },
    async close() { calls.push({ action: "close", directory }); },
  });
  const frame = { url: "branch-local://app/" };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { mainFrame: frame, send: (...args) => sent.push(args) },
  };
  const event = { sender: mainWindow.webContents, senderFrame: frame };
  const electron = {
    app: {
      getPath: () => virtualRoot, setPath() {}, setAppUserModelId() {},
      requestSingleInstanceLock: () => false, quit() {},
    },
    BrowserWindow: class { constructor() { windowCount += 1; } },
    Menu: {}, clipboard: {}, screen: {}, shell: {},
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => listeners.set(name, callback) },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      getSelectedStorageBackend: () => storageBackend,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString(),
    },
  };
  const mocks = {
    electron,
    "desktop-test:service": {
      async createLocalService(options) {
        calls.push({ action: "create", directory: options.dataDir });
        if (create) await create(options);
        return localService(options.dataDir);
      },
    },
    "desktop-test:migrate": { migrateLegacyData: async () => {} },
    "desktop-test:storage": {
      readStorageConfig: async (_profile, fallback) => fallback,
      async prepareDataDirectory(options) {
        calls.push({ action: "prepare", ...options });
        if (prepare) await prepare(options);
        return options.targetDir;
      },
      async writeStorageConfig(_profile, directory) {
        calls.push({ action: "config", directory });
        if (commit) await commit(directory);
        return directory;
      },
    },
  };
  const module = { exports: {} };
  const fakeProcess = {
    platform,
    argv: selfTest ? ["electron", "--self-test"] : [],
    env: selfTest ? { BRANCH_LOCAL_SMOKE_REPORT: path.join(virtualRoot, "unused-report.json") } : {},
  };
  new Function("require", "module", "exports", "process", bundle.outputFiles[0].text)(
    (name) => mocks[name] ?? require(name), module, module.exports, fakeProcess,
  );
  const integration = module.exports.integration;
  integration.setup(mainWindow, localService(sourceDir), sourceDir);
  integration.installIPC();
  t.after(() => { integration.cleanup(); assert.equal(windowCount, 0, "desktop tests must never open a window"); });
  return { integration, calls, sent, handlers, listeners, event, sourceDir, targetDir };
}

for (const mode of ["copy", "existing"]) {
  test(`native ${mode} directory switch commits config before replacing the service`, async (t) => {
    let h;
    h = harness(t, { commit: async () => {
      assert.equal(h.integration.state().dataDir, h.sourceDir);
      assert.equal(h.integration.state().service.directory, h.sourceDir);
    } });
    const result = await h.handlers.get("desktop:apply-data-directory")(h.event, { directory: h.targetDir, mode });
    assert.deepEqual(result, { directory: h.targetDir });
    assert.deepEqual(h.calls.map((entry) => entry.action), ["close", "prepare", "create", "config"]);
    assert.deepEqual(h.calls[1], { action: "prepare", sourceDir: h.sourceDir, targetDir: h.targetDir, mode });
    assert.equal(h.integration.state().dataDir, h.targetDir);
    assert.equal(h.integration.state().service.directory, h.targetDir);
    assert.equal(h.integration.state().storageReloadPending, true);
  });
}

test("directory switch rejects foreign senders, invalid arguments and overlapping operations", async (t) => {
  let release;
  const pendingPreparation = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { prepare: () => pendingPreparation });
  const apply = h.handlers.get("desktop:apply-data-directory");
  await assert.rejects(() => apply({ ...h.event, senderFrame: { url: "branch-local://app/" } }, { directory: h.targetDir, mode: "copy" }), /不允许/);
  await assert.rejects(() => apply(h.event, { directory: "relative", mode: "copy" }), /无效/);
  await assert.rejects(() => apply(h.event, { directory: h.targetDir, mode: "replace" }), /无效/);
  const pending = apply(h.event, { directory: h.targetDir, mode: "copy" });
  await Promise.resolve();
  assert.equal((await h.integration.handleProtocol(new Request("branch-local://app/api/health"))).status, 503);
  await assert.rejects(() => apply(h.event, { directory: h.targetDir, mode: "copy" }), /正在/);
  release();
  await pending;
  await assert.rejects(() => apply(h.event, { directory: h.sourceDir, mode: "existing" }), /正在/);
});

for (const failure of ["prepare", "create", "commit"]) {
  test(`${failure} failure reopens the old service and preserves the configured directory`, async (t) => {
    const effect = async (options) => {
      if (failure !== "create" || options.dataDir.endsWith(`${path.sep}target`)) throw new Error(`${failure} denied`);
    };
    const h = harness(t, { [failure]: effect });
    await assert.rejects(() => h.handlers.get("desktop:apply-data-directory")(h.event, { directory: h.targetDir, mode: "copy" }), /已恢复原数据目录/);
    assert.equal(h.integration.state().dataDir, h.sourceDir);
    assert.equal(h.integration.state().service.directory, h.sourceDir);
    assert.equal(h.integration.state().changingStorage, false);
    assert.equal(h.integration.state().storageReloadPending, false);
    assert.equal(h.calls.at(-1).action, "create");
    assert.equal(h.calls.at(-1).directory, h.sourceDir);
    if (failure === "commit")
      assert.ok(h.calls.some((entry) => entry.action === "close" && entry.directory === h.targetDir), "replacement service must close before rollback");
    assert.equal((await h.integration.handleProtocol(new Request("branch-local://app/api/health"))).status, 200);
  });
}

test("queued close waits until the reloaded renderer has all readiness signals", async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { prepare: () => wait });
  const pending = h.handlers.get("desktop:apply-data-directory")(h.event, { directory: h.targetDir, mode: "existing" });
  await Promise.resolve();
  h.integration.requestClose();
  assert.deepEqual(h.sent, []);
  release(); await pending;
  assert.deepEqual(h.sent, [], "old renderer must not flush its workspace into the new directory");
  h.listeners.get("desktop:application-ready")(h.event);
  h.listeners.get("desktop:renderer-ready")(h.event);
  assert.deepEqual(h.sent, [], "DOMContentLoaded and application state alone do not complete the reload");
  h.integration.pageLoaded();
  assert.deepEqual(h.sent, [["desktop:before-close"]]);
  assert.equal(h.integration.state().storageReloadPending, false);
  assert.equal(h.integration.state().closePending, true);
});

test("a canceled native directory picker has no storage or service effects", async (t) => {
  const h = harness(t);
  assert.equal(await h.handlers.get("desktop:choose-data-directory")(h.event), null);
  assert.deepEqual(h.calls, []);
  assert.equal(h.integration.state().dataDir, h.sourceDir);
});

test("smoke service disables automatic summaries before the renderer is loaded", async (t) => {
  const h = harness(t, { selfTest: true });
  await h.integration.createService(h.targetDir);
  assert.deepEqual(h.calls.map((entry) => entry.action), ["create", "api"]);
  assert.equal(h.calls[1].pathname, "/api/settings");
  assert.deepEqual(h.calls[1].body, { autoSummary: false });
});

test("Linux rejects the basic_text key backend before opening settings", async (t) => {
  const h = harness(t, { platform: "linux", storageBackend: "basic_text" });
  await assert.rejects(() => h.integration.createService(h.targetDir), /GNOME Keyring.*KWallet/);
  assert.deepEqual(h.calls, []);
});

test("desktop requires available system encryption on every platform", async (t) => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const h = harness(t, { platform, encryptionAvailable: false });
    await assert.rejects(() => h.integration.createService(h.targetDir), /系统密钥/);
    assert.deepEqual(h.calls, []);
  }
});
