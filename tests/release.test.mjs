import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectedAssets, validateTag, verifyAssets } from "../scripts/release.mjs";

test("release tag must exactly match the package version", () => {
  assert.equal(validateTag("1.5.1", "v1.5.1"), "v1.5.1");
  assert.equal(validateTag("2.0.0-beta.1", "v2.0.0-beta.1"), "v2.0.0-beta.1");
  for (const tag of ["main", "1.5.1", "v1.5.0", "v1.5.1\nsha=injected", undefined])
    assert.throws(() => validateTag("1.5.1", tag), /must match/);
  assert.throws(() => validateTag("../outside", "v../outside"), /must match/);
});

test("publishing requires all eight nonempty platform packages", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branch-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = expectedAssets("1.5.1");
  assert.equal(new Set(names).size, 8);
  for (const name of names.slice(0, -1)) await writeFile(path.join(directory, name), "package");
  const last = path.join(directory, names.at(-1));
  await assert.rejects(verifyAssets(directory, "1.5.1"), { code: "ENOENT" });
  await writeFile(last, "");
  await assert.rejects(verifyAssets(directory, "1.5.1"), /Invalid release package/);
  await rm(last);
  await mkdir(last);
  await assert.rejects(verifyAssets(directory, "1.5.1"), /Invalid release package/);
  await rm(last, { recursive: true });
  await writeFile(last, "package");
  assert.deepEqual(await verifyAssets(directory, "1.5.1"), names);
  await assert.rejects(verifyAssets(directory, "1.5.2"), { code: "ENOENT" });
});
