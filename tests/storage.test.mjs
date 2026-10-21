import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspace } from "../shared/core.mjs";
import { readStorageConfig, prepareDataDirectory, writeStorageConfig } from "../desktop/storage.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "branch-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "target");
  const profileDir = path.join(root, "profile");
  await mkdir(sourceDir);
  const files = {
    "workspace.json": `${JSON.stringify(createWorkspace())}\n`,
    "workspace.json.backup": `${JSON.stringify(createWorkspace())}\n`,
    "settings.json": '{"model":"test-model","encryptedApiKey":"opaque-sealed-value","rememberKey":true}\n',
  };
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(path.join(sourceDir, name), text)));
  return { root, sourceDir, targetDir, profileDir, files };
}

test("directory copy retains source files and only copies application data with exact bytes", async (t) => {
  const { sourceDir, targetDir, files } = await fixture(t);
  await writeFile(path.join(sourceDir, "unrelated.txt"), "leave in source");
  assert.equal(await prepareDataDirectory({ sourceDir, targetDir, mode: "copy" }), targetDir);
  assert.deepEqual((await readdir(targetDir)).sort(), Object.keys(files).sort());
  for (const [name, text] of Object.entries(files)) {
    assert.equal(await readFile(path.join(sourceDir, name), "utf8"), text);
    assert.equal(await readFile(path.join(targetDir, name), "utf8"), text);
  }
});

test("copy rejects nonempty targets, never overwrites workspace/settings and leaves source intact", async (t) => {
  const { sourceDir, targetDir, files } = await fixture(t);
  await mkdir(targetDir);
  await writeFile(path.join(targetDir, "settings.json"), "do not replace");
  await assert.rejects(() => prepareDataDirectory({ sourceDir, targetDir, mode: "copy" }), /目标目录不为空/);
  assert.equal(await readFile(path.join(targetDir, "settings.json"), "utf8"), "do not replace");
  assert.equal(await readFile(path.join(sourceDir, "workspace.json"), "utf8"), files["workspace.json"]);
  await assert.rejects(() => readFile(path.join(targetDir, "workspace.json")), { code: "ENOENT" });
});

test("existing requires a validated workspace or recoverable backup and never creates an empty dataset", async (t) => {
  const { sourceDir, targetDir, files } = await fixture(t);
  await assert.rejects(() => prepareDataDirectory({ sourceDir, targetDir, mode: "existing" }), /没有有效/);
  await assert.rejects(() => readdir(targetDir), { code: "ENOENT" });
  await mkdir(targetDir);
  await writeFile(path.join(targetDir, "workspace.json"), "{broken");
  await assert.rejects(() => prepareDataDirectory({ sourceDir, targetDir, mode: "existing" }), /没有有效/);
  await writeFile(path.join(targetDir, "workspace.json.backup"), files["workspace.json.backup"]);
  assert.equal(await prepareDataDirectory({ sourceDir, targetDir, mode: "existing" }), targetDir);
  assert.equal(await readFile(path.join(targetDir, "workspace.json"), "utf8"), "{broken");
});

test("self copies are a no-op, nested copies are rejected and recovered sources keep their backups", async (t) => {
  const { sourceDir, targetDir, files } = await fixture(t);
  assert.equal(await prepareDataDirectory({ sourceDir, targetDir: path.join(sourceDir, "."), mode: "copy" }), sourceDir);
  const child = path.join(sourceDir, "nested", "data");
  await assert.rejects(() => prepareDataDirectory({ sourceDir, targetDir: child, mode: "copy" }), /不能位于当前数据目录内部/);
  await assert.rejects(() => readdir(child), { code: "ENOENT" });
  await writeFile(path.join(sourceDir, "workspace.json"), "{damaged");
  await prepareDataDirectory({ sourceDir, targetDir, mode: "copy" });
  assert.equal(await readFile(path.join(targetDir, "workspace.json.backup"), "utf8"), files["workspace.json.backup"]);
  assert.equal(await readFile(path.join(sourceDir, "workspace.json"), "utf8"), "{damaged");
});

test("storage config defaults, validates absolute paths and atomically replaces valid configurations", async (t) => {
  const { profileDir, sourceDir, targetDir } = await fixture(t);
  assert.equal(await readStorageConfig(profileDir, sourceDir), sourceDir);
  await writeStorageConfig(profileDir, sourceDir);
  assert.equal(await readStorageConfig(profileDir, targetDir), sourceDir);
  const original = await readFile(path.join(profileDir, "storage.json"), "utf8");
  await assert.rejects(() => writeStorageConfig(profileDir, "\0bad"), /有效的目录路径/);
  assert.equal(await readFile(path.join(profileDir, "storage.json"), "utf8"), original);
  await writeStorageConfig(profileDir, targetDir);
  assert.equal(await readStorageConfig(profileDir, sourceDir), targetDir);
  assert.deepEqual(await readdir(profileDir), ["storage.json"]);
  for (const content of ['{broken', '{}', '{"dataDirectory":"relative/data"}', '[]']) {
    await writeFile(path.join(profileDir, "storage.json"), content);
    await assert.rejects(() => readStorageConfig(profileDir, sourceDir), /storage.json.*dataDirectory/);
    assert.equal(await readFile(path.join(profileDir, "storage.json"), "utf8"), content);
  }
});

test("failed atomic config commits leave the preexisting path untouched and clean their temporary files", async (t) => {
  const { profileDir, sourceDir } = await fixture(t);
  await mkdir(path.join(profileDir, "storage.json"), { recursive: true });
  await writeFile(path.join(profileDir, "storage.json", "keep.txt"), "existing content");
  await assert.rejects(() => writeStorageConfig(profileDir, sourceDir), /原配置未被删除/);
  assert.equal(await readFile(path.join(profileDir, "storage.json", "keep.txt"), "utf8"), "existing content");
  assert.deepEqual(await readdir(profileDir), ["storage.json"]);
});
