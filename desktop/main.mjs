import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  screen,
  shell,
} from "electron";
import { readFile, writeFile, realpath, stat } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalService } from "../server/service.mjs";
import { resolveShortcuts, formatShortcut } from '../shared/shortcuts.mjs';
import { migrateLegacyData } from "./migrate.mjs";
import { readMaterialDocuments } from "./materials.mjs";
import { readStorageConfig, prepareDataDirectory, writeStorageConfig } from "./storage.mjs";
import {
  APP_URL,
  isAppUrl,
  assetFilename,
  safeFilename,
  restoreBounds,
} from "./security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeReport = process.argv.includes("--self-test")
  ? process.env.BRANCH_LOCAL_SMOKE_REPORT
  : null;
const profileDir = path.resolve(
  process.env.BRANCH_LOCAL_USER_DATA ||
    path.join(app.getPath("appData"), "BranchLocal"),
);
const defaultDataDir = path.join(profileDir, "data");
let dataDir = defaultDataDir;
const windowStateFile = path.join(profileDir, "window-state.json");
app.setPath("userData", profileDir);
app.setAppUserModelId("com.branchlocal.desktop");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "branch-local",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow = null;
let service = null;
let menuSettingsRequest = 0;
let allowClose = false;
let shutdownComplete = false;
let shutdownPromise = null;
let closePending = false;
let closeTimer = null;
let rendererReady = false;
let pageReady = false;
let applicationReady = false;
let smokeStarted = false;
let smokeResult = null;
let changingStorage = false;
let closeAfterStorage = false;
let storageReloadPending = false;
let importingMaterials = false;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

async function migrateLegacyWorkspace() {
  if (app.isPackaged) return;
  await migrateLegacyData({
    sourceDir: path.join(root, "data"),
    targetDir: dataDir,
  });
}

async function createService(directory) {
  if (!safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"))
    throw new Error(process.platform === "linux"
      ? "系统密钥存储不可用。请安装并解锁 GNOME Keyring 或 KWallet 后重新打开枝间。"
      : "系统密钥加密服务不可用，无法安全打开桌面配置。");
  const local = await createLocalService({
    dataDir: directory,
    allowAgent: true,
    secretCodec: {
      encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
  });
  // Self-tests never submit the demonstration conversation to a real model.
  if (smokeReport) {
    try {
      const response = await local.handle(new Request(`${APP_URL}api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoSummary: false }),
      }));
      if (!response.ok) throw new Error("无法关闭测试环境的自动总结。");
    } catch (error) {
      await local.close();
      throw error;
    }
  }
  return local;
}

async function handleProtocol(request) {
  if (
    !isAppUrl(request.url) ||
    (request.initiatorOrigin && !isAppUrl(request.initiatorOrigin))
  )
    return new Response("Forbidden", { status: 403 });
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (changingStorage || !service)
        return Response.json({ error: "正在切换数据目录，请稍后重试。" }, {
          status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" },
        });
      const settingsRequest = url.pathname === '/api/settings' && ['GET','PUT'].includes(request.method) ? ++menuSettingsRequest : null;
      const response = await service.handle(request);
      if (settingsRequest !== null && settingsRequest === menuSettingsRequest && response.ok) {
        const settings = await response.clone().json();
        if (settingsRequest === menuSettingsRequest) installMenu(settings.shortcuts);
      }
      return response;
    }
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const dist = await realpath(path.join(root, "dist"));
    const target = await realpath(assetFilename(dist, request.url));
    const relative = path.relative(dist, target);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !(await stat(target)).isFile()
    )
      return new Response("Forbidden", { status: 403 });
    const bytes = request.method === "HEAD" ? null : await readFile(target);
    return new Response(bytes, {
      headers: {
        "Content-Type":
          MIME[path.extname(target)] || "application/octet-stream",
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return new Response(
      error.code === "ENOENT"
        ? "Resource not found"
        : "Unable to load application resource",
      { status: error.code === "ENOENT" ? 404 : 400 },
    );
  }
}

function assertSender(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !isAppUrl(event.senderFrame.url)
  )
    throw new Error("不允许的应用请求。");
}

function assertAgentDirectoryReady(event) {
  assertSender(event);
  if (!service || changingStorage || storageReloadPending || closePending || shutdownPromise || shutdownComplete)
    throw new Error("应用正在保存或切换数据目录，请稍后重试。");
}

function publishWindowState() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("desktop:window-state", {
      maximized: mainWindow.isMaximized(),
    });
}

function rememberWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const value = {
      ...mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized(),
    };
    writeFileSync(`${windowStateFile}.tmp`, JSON.stringify(value));
    renameSync(`${windowStateFile}.tmp`, windowStateFile);
  } catch (error) {
    console.error("Unable to save window position:", error.code);
  }
}

async function confirmUnsavedClose(detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "尚有内容未保存",
    message: "工作区尚未成功保存。",
    detail: detail || "返回应用后可以重试保存或导出备份。",
    buttons: ["返回应用", "仍然退出"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response === 1) {
    allowClose = true;
    mainWindow.close();
  } else closePending = false;
}

function requestClose() {
  if (!mainWindow || mainWindow.isDestroyed() || closePending) return;
  if (changingStorage || storageReloadPending) {
    closeAfterStorage = true;
    return;
  }
  closePending = true;
  mainWindow.webContents.send("desktop:before-close");
  closeTimer = setTimeout(() => {
    void confirmUnsavedClose(
      "应用未能及时确认保存状态。返回后可以等待保存完成，或导出备份。",
    );
  }, 20000);
}

function finishStorageReload() {
  if (!storageReloadPending || !rendererReady || !pageReady || !applicationReady) return;
  storageReloadPending = false;
  if (closeAfterStorage) {
    closeAfterStorage = false;
    requestClose();
  }
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("desktop:command", command);
}

function installMenu(overrides) {
  const shortcuts = resolveShortcuts(overrides);
  // Chromium receives keyboard events so the renderer can respect text inputs,
  // modal dialogs and the selected target. Native accelerators would bypass it.
  const item = (label, command) => ({
    label: `${label}${shortcuts[command] ? `    ${formatShortcut(shortcuts[command])}` : ''}`,
    click: () => sendCommand(command),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{
        label: "枝间",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { label: "退出枝间", accelerator: "Command+Q", click: () => mainWindow?.close() },
        ],
      }] : []),
      {
        label: "文件",
        submenu: [
          item("新建会话", "new-conversation"),
          item("新建画布", "new-board"),
          { type: "separator" },
          item("导入工作区…", "import"),
          { label: "导入资料（Markdown / PDF）…", click: () => sendCommand("import-materials") },
          item("导出工作区…", "export"),
          item("导出当前会话…", "export-conversation"),
          { label: "打开数据目录", click: () => void shell.openPath(dataDir) },
          { type: "separator" },
          {
            label: process.platform === "darwin" ? "退出    Command + Q" : "退出    Alt + F4",
            click: () => mainWindow?.close(),
          },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { label: "撤销文本编辑", click:()=>mainWindow?.webContents.undo() },
          { label: "重做文本编辑", click:()=>mainWindow?.webContents.redo() },
          { type: "separator" },
          { label: "剪切", click:()=>mainWindow?.webContents.cut() },
          { label: "复制", click:()=>mainWindow?.webContents.copy() },
          { label: "粘贴", click:()=>mainWindow?.webContents.paste() },
          { label: "全选", click:()=>mainWindow?.webContents.selectAll() },
          { type: "separator" },
          item("搜索对话", "search"),
          item("撤销最近一次移除", "undo-remove"),
        ],
      },
      {
        label:'会话', submenu:[
          item('创建分支','branch'), item('合并会话','merge'),
          item('重命名','rename'), item('复制会话与子分支','duplicate'),
          item('更新总结','summary'), item('折叠/展开子分支','toggle-children'),
          item('聚焦输入框','focus-composer'),
          {type:'separator'}, item('归档','archive'), item('移入回收站','trash'),
        ],
      },
      {
        label: "视图",
        submenu: [
          item("适应画布", "fit"),
          item("自动排列", "arrange"),
          item('居中当前会话','focus-node'),
          item('打开归档','show-archive'), item('打开回收站','show-trash'),
          { label: "全屏", click:()=>mainWindow?.setFullScreen(!mainWindow.isFullScreen()) },
          { type: "separator" },
          item("模型与偏好…", "settings"),
          ...(!app.isPackaged
            ? [{ label: "开发者工具", click:()=>mainWindow?.webContents.toggleDevTools() }]
            : []),
        ],
      },
      {
        label: "帮助",
        submenu: [
          item("使用指南", "help"),
          {
            label: "关于枝间",
            click: () =>
              dialog.showMessageBox(mainWindow, {
                title: "关于枝间",
                message: `枝间 · Branch Local ${app.getVersion()}`,
                detail:
                  "本地 AI 分支对话画布\n独立桌面窗口 · 数据保存在本机\n模型由你连接的 Ollama 或兼容 API 提供。",
                buttons: ["好的"],
                noLink: true,
              }),
          },
        ],
      },
    ]),
  );
}

function installIPC() {
  ipcMain.handle("desktop:window", (event, action) => {
    assertSender(event);
    if (action === "minimize") mainWindow.minimize();
    else if (action === "maximize")
      mainWindow.isMaximized()
        ? mainWindow.unmaximize()
        : mainWindow.maximize();
    else if (action === "close") mainWindow.close();
    else throw new Error("无效的窗口操作。");
  });
  ipcMain.handle("desktop:state", (event) => {
    assertSender(event);
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle("desktop:save-file", async (event, options) => {
    assertSender(event);
    if (
      !options ||
      typeof options.text !== "string" ||
      Buffer.byteLength(options.text, "utf8") > 64 * 1024 * 1024
    )
      throw new Error("导出内容为空或过大。");
    const markdown = options.type?.includes("markdown");
    const result = await dialog.showSaveDialog(mainWindow, {
      title: markdown ? "导出对话" : "导出工作区",
      defaultPath: path.join(
        app.getPath("documents"),
        safeFilename(options.name),
      ),
      filters: markdown
        ? [{ name: "Markdown", extensions: ["md"] }]
        : [{ name: "工作区 JSON", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, options.text, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { saved: true, path: result.filePath };
  });
  ipcMain.handle("desktop:open-file", async (event) => {
    assertSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入工作区",
      filters: [{ name: "工作区 JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filename = result.filePaths[0];
    if ((await stat(filename)).size > 64 * 1024 * 1024)
      throw new Error("导入文件不能超过 64 MB。");
    return {
      name: path.basename(filename),
      text: await readFile(filename, "utf8"),
    };
  });
  ipcMain.handle("desktop:open-data-directory", async (event) => {
    assertSender(event);
    const error = await shell.openPath(dataDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle("desktop:import-materials", async (event) => {
    assertSender(event);
    if (importingMaterials) throw new Error("已有资料正在导入，请等待完成。");
    if (changingStorage || storageReloadPending) throw new Error("正在切换数据目录，请稍后导入资料。");
    importingMaterials = true;
    try {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: "导入本地资料",
        filters: [
          { name: "Markdown、文本与 PDF", extensions: ["md", "markdown", "txt", "pdf"] },
          { name: "Markdown 与文本", extensions: ["md", "markdown", "txt"] },
          { name: "PDF", extensions: ["pdf"] },
        ],
        properties: ["openFile", "multiSelections"],
      });
      assertSender(event);
      if (selected.canceled || !selected.filePaths.length) return { canceled: true, documents: [] };
      const documents = await readMaterialDocuments(selected.filePaths);
      assertSender(event);
      return { canceled: false, documents };
    } finally { importingMaterials = false; }
  });
  ipcMain.handle("desktop:choose-agent-directory", async (event) => {
    assertAgentDirectoryReady(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Agent 工作目录",
      properties: ["openDirectory"],
    });
    assertAgentDirectoryReady(event);
    if (result.canceled || !result.filePaths[0]) return { canceled: true, directory: "" };
    const directory = await realpath(path.resolve(result.filePaths[0]));
    if (!(await stat(directory)).isDirectory()) throw new Error("请选择有效的文件夹。");
    assertAgentDirectoryReady(event);
    return { canceled: false, directory };
  });
  ipcMain.handle("desktop:open-agent-directory", async (event) => {
    assertAgentDirectoryReady(event);
    const response = await service.handle(new Request(`${APP_URL}api/settings`));
    if (!response.ok) throw new Error("无法读取 Agent 工作目录设置。");
    const settings = await response.json();
    if (typeof settings.agentWorkspace !== "string" || !path.isAbsolute(settings.agentWorkspace))
      throw new Error("请先选择并保存 Agent 工作目录。");
    const directory = await realpath(settings.agentWorkspace);
    if (!(await stat(directory)).isDirectory()) throw new Error("Agent 工作目录不存在。");
    assertAgentDirectoryReady(event);
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return { opened: true };
  });
  ipcMain.handle("desktop:choose-data-directory", async (event) => {
    assertSender(event);
    if (changingStorage || storageReloadPending || closePending) throw new Error("应用正在保存或切换数据目录，请稍后重试。");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择对话数据目录",
      defaultPath: dataDir,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = path.resolve(result.filePaths[0]);
    const files = await Promise.all(["workspace.json", "workspace.json.backup"].map(async (filename) => {
      try { return (await stat(path.join(directory, filename))).isFile(); }
      catch (error) {
        if (error.code === "ENOENT") return false;
        throw new Error("无法检查所选目录，请确认目录的读取权限。", { cause: error });
      }
    }));
    return { directory, hasWorkspace: files.some(Boolean) };
  });
  ipcMain.handle("desktop:apply-data-directory", async (event, options) => {
    assertSender(event);
    if (changingStorage || storageReloadPending || closePending) throw new Error("应用正在保存或切换数据目录，请稍后重试。");
    if (!options || typeof options !== "object" || Array.isArray(options)
      || typeof options.directory !== "string" || !path.isAbsolute(options.directory)
      || !["copy", "existing"].includes(options.mode))
      throw new Error("数据目录或切换方式无效。");
    const targetDir = path.resolve(options.directory);
    if ((process.platform === "win32" ? targetDir.toLowerCase() === dataDir.toLowerCase() : targetDir === dataDir))
      return { directory: dataDir };
    changingStorage = true;
    const previousDir = dataDir;
    let replacement = null;
    try {
      // The renderer flushes its edits before invoking this handler. Closing the
      // service additionally drains pending writes and aborts model requests.
      await service.close();
      const prepared = await prepareDataDirectory({ sourceDir: previousDir, targetDir, mode: options.mode });
      replacement = await createService(prepared);
      await writeStorageConfig(profileDir, prepared);
      service = replacement;
      dataDir = prepared;
      replacement = null;
      // Only the reloaded renderer knows the new workspace. Until all readiness
      // signals arrive, an old renderer must never save its state while closing.
      storageReloadPending = true;
      rendererReady = false;
      pageReady = false;
      applicationReady = false;
      return { directory: dataDir };
    } catch (error) {
      await replacement?.close().catch(() => {});
      try { service = await createService(previousDir); }
      catch (restoreError) {
        service = null;
        throw new Error(`切换目录失败，旧目录仍保留，但无法重新打开：${restoreError.message}。请重新启动应用。`, { cause: error });
      }
      throw new Error(`切换目录失败，已恢复原数据目录：${error.message}`, { cause: error });
    } finally {
      changingStorage = false;
      if (closeAfterStorage && !storageReloadPending) {
        closeAfterStorage = false;
        requestClose();
      }
    }
  });
  ipcMain.handle("desktop:copy-text", (event, text) => {
    assertSender(event);
    if (typeof text !== "string" || text.length > 100100)
      throw new Error("复制内容无效或过长。");
    clipboard.writeText(text);
  });
  ipcMain.handle("desktop:close-ready", async (event, saved) => {
    assertSender(event);
    if (!closePending) return;
    clearTimeout(closeTimer);
    closeTimer = null;
    if (smokeReport && smokeResult) {
      const persisted = JSON.parse(
        await readFile(path.join(dataDir, "workspace.json"), "utf8"),
      );
      await writeFile(
        smokeReport,
        JSON.stringify(
          {
            ...smokeResult,
            ok: saved === true,
            rendererSavedBeforeClose: saved === true,
            persistedRevision: persisted.revision,
          },
          null,
          2,
        ),
      );
      allowClose = true;
      mainWindow.close();
    } else if (saved === true) {
      allowClose = true;
      mainWindow.close();
    } else {
      void confirmUnsavedClose();
    }
  });
  ipcMain.on("desktop:renderer-ready", (event) => {
    assertSender(event);
    rendererReady = true;
    finishStorageReload();
    void finishSmoke();
  });
  ipcMain.on("desktop:application-ready", (event) => {
    assertSender(event);
    applicationReady = true;
    finishStorageReload();
    void finishSmoke();
  });
}

async function finishSmoke() {
  if (
    !smokeReport ||
    smokeStarted ||
    !rendererReady ||
    !pageReady ||
    !applicationReady
  )
    return;
  smokeStarted = true;
  try {
    const health = await service.handle(new Request(`${APP_URL}api/health`));
    const workspace = await (
      await service.handle(new Request(`${APP_URL}api/workspace`))
    ).json();
    const settings = await (
      await service.handle(new Request(`${APP_URL}api/settings`))
    ).json();
    const nativeMaterialsImport = await mainWindow.webContents.executeJavaScript(
      "typeof window.branchDesktop?.importMaterials === 'function'",
    );
    const { checkMaterialRuntime }=await import('./material-smoke.mjs');
    const pdfMaterialExtraction=await checkMaterialRuntime(path.dirname(smokeReport));
    if (
      !health.ok ||
      !workspace.boards.length ||
      settings.keyStorage !== "encrypted" ||
      !nativeMaterialsImport
    )
      throw new Error("Desktop service checks failed");
    smokeResult = {
      ok: true,
      version: app.getVersion(),
      url: APP_URL,
      preloadReady: rendererReady,
      pageReady,
      applicationReady,
      encryptedKeyStorage: settings.keyStorage,
      nativeMaterialsImport,
      pdfMaterialExtraction,
      boardCount: workspace.boards.length,
      dataDirectory: dataDir,
      listeningPort: null,
    };
    requestClose();
  } catch (error) {
    await writeFile(
      smokeReport,
      JSON.stringify({ ok: false, error: error.message }),
    );
    allowClose = true;
    mainWindow?.destroy();
  }
}

async function createWindow() {
  let state = {};
  try {
    state = JSON.parse(await readFile(windowStateFile, "utf8"));
  } catch {
    /* First launch uses the default window. */
  }
  const bounds = restoreBounds(state, screen.getAllDisplays());
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 640,
    title: "枝间 · Branch Local",
    icon: path.join(root, "build", "icon.png"),
    backgroundColor: "#f5f6f1",
    frame: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, "desktop", "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  mainWindow.webContents.on("console-message", (details) => {
    if (!app.isPackaged && details.level === "error")
      console.error("[Renderer]", details.message);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer stopped:", details.reason);
  });
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.on("did-finish-load", () => {
    pageReady = true;
    finishStorageReload();
    void finishSmoke();
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) {
        console.error("Application load failed:", code, description);
        if (!smokeReport)
          dialog.showErrorBox(
            "无法打开枝间",
            "应用资源加载失败。请重新启动应用；已保存的数据不受影响。",
          );
      }
    },
  );
  mainWindow.on("ready-to-show", () => {
    if (!smokeReport) {
      if (state.maximized) mainWindow.maximize();
      mainWindow.show();
    }
  });
  mainWindow.on("maximize", publishWindowState);
  mainWindow.on("unmaximize", publishWindowState);
  mainWindow.on("close", (event) => {
    rememberWindow();
    if (!allowClose) {
      event.preventDefault();
      requestClose();
    }
  });
  mainWindow.on("closed", () => {
    clearTimeout(closeTimer);
    mainWindow = null;
  });
  await mainWindow.loadURL(APP_URL);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
      return;
    }
    if (!shutdownPromise)
      shutdownPromise = Promise.resolve(service?.close()).finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });
  app.on("window-all-closed", () => app.quit());
  app
    .whenReady()
    .then(async () => {
      dataDir = await readStorageConfig(profileDir, defaultDataDir);
      if (dataDir === defaultDataDir) await migrateLegacyWorkspace();
      service = await createService(dataDir);
      protocol.handle("branch-local", handleProtocol);
      installIPC();
      installMenu();
      await createWindow();
    })
    .catch(async (error) => {
      console.error(error);
      if (smokeReport)
        await writeFile(
          smokeReport,
          JSON.stringify({ ok: false, error: error.message }),
        ).catch(() => {});
      else
        dialog.showErrorBox(
          "枝间启动失败",
          `${error.message}\n\n数据目录：${dataDir}`,
        );
      shutdownComplete = true;
      await service?.close();
      app.exit(1);
    });
}
