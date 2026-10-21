import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspace } from "../shared/core.mjs";
import { migrateLegacyData } from "../desktop/migrate.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "branch-migration-"));
  const sourceDir = path.join(root, "legacy"),
    targetDir = path.join(root, "profile");
  await mkdir(sourceDir);
  return { sourceDir, targetDir };
}
test("desktop upgrade migrates conversation data once and preserves original files", async () => {
  const options = await fixture();
  const workspace = createWorkspace();
  const source = JSON.stringify(workspace);
  await writeFile(path.join(options.sourceDir, "workspace.json"), source);
  assert.equal(await migrateLegacyData(options), true);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(options.targetDir, "workspace.json"), "utf8"),
    ),
    workspace,
  );
  assert.equal(
    await readFile(path.join(options.sourceDir, "workspace.json"), "utf8"),
    source,
  );
  const changed = createWorkspace();
  await writeFile(
    path.join(options.sourceDir, "workspace.json"),
    JSON.stringify(changed),
  );
  assert.equal(await migrateLegacyData(options), false);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(options.targetDir, "workspace.json"), "utf8"),
    ),
    workspace,
  );
});
test("migration can recover a valid backup when legacy primary is damaged", async () => {
  const options = await fixture();
  const workspace = createWorkspace();
  await writeFile(path.join(options.sourceDir, "workspace.json"), "{broken");
  await writeFile(
    path.join(options.sourceDir, "workspace.json.backup"),
    JSON.stringify(workspace),
  );
  assert.equal(await migrateLegacyData(options), true);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(options.targetDir, "workspace.json"), "utf8"),
    ),
    workspace,
  );
  assert.equal(
    await readFile(path.join(options.sourceDir, "workspace.json"), "utf8"),
    "{broken",
  );
});
test("an existing profile backup takes priority over legacy data", async () => {
  const options = await fixture();
  await mkdir(options.targetDir);
  const workspace = createWorkspace();
  await writeFile(
    path.join(options.targetDir, "workspace.json.backup"),
    JSON.stringify(workspace),
  );
  assert.equal(await migrateLegacyData(options), false);
});
test("missing legacy files are normal; damaged primary and backup fail without deletion", async () => {
  const options = await fixture();
  assert.equal(await migrateLegacyData(options), false);
  await writeFile(path.join(options.sourceDir, "workspace.json"), "damaged");
  await assert.rejects(migrateLegacyData(options), /旧工作区和备份/);
  assert.equal(
    await readFile(path.join(options.sourceDir, "workspace.json"), "utf8"),
    "damaged",
  );
});
