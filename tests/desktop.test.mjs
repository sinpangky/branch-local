import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  isAppUrl,
  assetFilename,
  safeFilename,
  restoreBounds,
} from "../desktop/security.mjs";

test("desktop bridge reports the packaged application version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  let bridge;
  runInNewContext(source, {
    require: (name) => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, "branchDesktop"); bridge = value; } }, ipcRenderer: {} };
    },
    process: { platform: "win32" },
    window: { addEventListener() {} },
  });
  assert.equal(bridge.version, manifest.version);
});

test("desktop protocol only trusts its own host without credentials or ports", () => {
  assert(isAppUrl("branch-local://app/api/workspace"));
  for (const value of [
    "http://127.0.0.1:4317",
    "branch-local://evil/index.html",
    "branch-local://user@app/",
    "branch-local://app:22/",
    "javascript:alert(1)",
    null,
  ])
    assert.equal(isAppUrl(value), false);
});
test("bundled assets resolve within the application directory", () => {
  const root = path.resolve("test-bundle");
  assert.equal(
    assetFilename(root, "branch-local://app/"),
    path.join(root, "index.html"),
  );
  assert.equal(
    assetFilename(root, "branch-local://app/assets/main.js?v=1"),
    path.join(root, "assets", "main.js"),
  );
  for (const url of [
    "branch-local://app/%2e%2e%5csecret",
    "branch-local://app/%00",
    "branch-local://app/%xx",
    "https://app/assets/a.js",
  ])
    assert.throws(() => assetFilename(root, url));
});
test("native exports sanitize invalid Windows file names", () => {
  assert.equal(safeFilename("NUL.json"), "枝间-导出.json");
  assert.equal(safeFilename("a:b?.md"), "a-b-.md");
  assert.equal(safeFilename("a.json..."), "a.json");
  assert.throws(() => safeFilename({}));
});
test("window restoration keeps offscreen positions from hiding the app", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(
    restoreBounds({ x: -9000, y: -4000, width: 1280, height: 800 }, displays),
    { width: 1280, height: 800 },
  );
  assert.deepEqual(
    restoreBounds({ x: 200, y: 50, width: 1200, height: 800 }, displays),
    { x: 200, y: 50, width: 1200, height: 800 },
  );
  assert.deepEqual(restoreBounds({ width: NaN, height: 800 }, displays), {
    width: 1440,
    height: 940,
  });
});
