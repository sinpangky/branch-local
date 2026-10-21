import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import afterPack from "../build/after-pack.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "branch-packaging-"));
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }));
  const appOutDir = path.join(temporary, "App Directory with spaces");
  await mkdir(appOutDir);
  return { temporary, appOutDir };
}
const context = (appOutDir, executableName) => ({
  electronPlatformName: "linux", appOutDir, packager: { executableName },
});

test("afterPack leaves Windows and macOS output untouched", async (t) => {
  const { appOutDir } = await fixture(t);
  const filename = path.join(appOutDir, "AppRun");
  await writeFile(filename, "existing launcher");
  for (const electronPlatformName of ["win32", "darwin"]) {
    // Other platforms do not need Linux-only packager properties.
    await afterPack({ electronPlatformName, appOutDir });
    assert.equal(await readFile(filename, "utf8"), "existing launcher");
    assert.deepEqual(await readdir(appOutDir), ["AppRun"]);
  }
});

test("Linux output uses a portable launcher with shell-quoted executable and no sandbox bypass", async (t) => {
  const { appOutDir } = await fixture(t);
  await afterPack(context(appOutDir, "Branch Local's $(touch unwanted) `echo injected`"));
  const filename = path.join(appOutDir, "AppRun");
  const launcher = await readFile(filename, "utf8");
  assert.ok(launcher.startsWith("#!/bin/sh\n"));
  assert.ok(launcher.includes('APPDIR=$(CDPATH= cd -P "$(dirname "$app_run")" && pwd -P)'));
  assert.ok(launcher.includes('export APPDIR\n'));
  assert.ok(launcher.includes('LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"'));
  assert.ok(launcher.includes(`exec "$APPDIR"/'Branch Local'\\''s $(touch unwanted) \`echo injected\`' "$@"`));
  assert.doesNotMatch(launcher, /--no-sandbox|unshare|NO_SANDBOX|args=\(/);
  assert.doesNotMatch(launcher, /\r/);
  if (process.platform !== "win32") assert.equal((await stat(filename)).mode & 0o777, 0o755);
});

test("Linux output rejects executable paths instead of writing a launcher outside its AppDir", async (t) => {
  const { appOutDir } = await fixture(t);
  for (const name of ["", ".", "..", "../outside", "nested/executable", "nested\\executable", "bad\0name", undefined])
    await assert.rejects(afterPack(context(appOutDir, name)), /executableName/);
  assert.deepEqual(await readdir(appOutDir), []);
});

test("electron-builder staging copies the custom AppRun over its generated sandbox-bypass launcher", async (t) => {
  const { temporary, appOutDir } = await fixture(t);
  const { copyDir } = require("builder-util");
  const { generateAppRunScript } = require("app-builder-lib/out/targets/appimage/appImageUtil.js");
  const stageDir = path.join(temporary, "AppImage stage");
  await mkdir(stageDir);
  await writeFile(path.join(stageDir, "AppRun"), generateAppRunScript({
    ExecutableName: "branchlocal", ProductName: "Branch Local", ProductFilename: "branchlocal",
    DesktopFileName: "branchlocal.desktop", ResourceName: "appimagekit-branchlocal",
  }), { mode: 0o755 });
  assert.match(await readFile(path.join(stageDir, "AppRun"), "utf8"), /--no-sandbox/);
  await afterPack(context(appOutDir, "branchlocal"));
  await copyDir(appOutDir, stageDir);
  assert.equal(await readFile(path.join(stageDir, "AppRun"), "utf8"), await readFile(path.join(appOutDir, "AppRun"), "utf8"));
});

test("extracted AppRun preserves arguments, uses its directory and prepends bundled libraries", { skip: process.platform === "win32" }, async (t) => {
  const { temporary, appOutDir } = await fixture(t);
  const executableName = "Branch Local's $(touch unwanted) `echo injected`";
  await afterPack(context(appOutDir, executableName));
  await writeFile(path.join(appOutDir, executableName), `#!/bin/sh
printf '%s\\0' "$APPDIR" "$LD_LIBRARY_PATH" "$@"
`, { mode: 0o755 });
  const { APPDIR: _appDir, LD_LIBRARY_PATH: _libraries, ...baseEnvironment } = process.env;
  const args = ["", "two words", "single' and double\"", "$HOME $(touch unwanted)", "line one\nline two", "--literal=42"];
  const { stdout } = await execute(path.join(appOutDir, "AppRun"), args, { cwd: temporary, env: baseEnvironment });
  const directory = await realpath(appOutDir);
  assert.deepEqual(stdout.split("\0"), [directory, `${directory}/usr/lib`, ...args, ""]);
  assert.deepEqual((await readdir(temporary)).sort(), [path.basename(appOutDir)]);
});

test("AppRun honors runtime APPDIR and keeps explicit arguments and existing library paths", { skip: process.platform === "win32" }, async (t) => {
  const { temporary, appOutDir } = await fixture(t);
  const executableName = "different executable";
  await afterPack(context(appOutDir, executableName));
  const mounted = path.join(temporary, "Mounted AppDir");
  await mkdir(mounted);
  await writeFile(path.join(mounted, executableName), `#!/bin/sh
printf '%s\\0' "$APPDIR" "$LD_LIBRARY_PATH" "$@"
exit 23
`, { mode: 0o755 });
  await assert.rejects(
    execute(path.join(appOutDir, "AppRun"), ["explicit argument", "--no-sandbox"], {
      cwd: temporary, env: { ...process.env, APPDIR: mounted, LD_LIBRARY_PATH: "/existing path/lib:/another/lib" },
    }),
    (error) => {
      assert.equal(error.code, 23, "exec preserves the application's exit code");
      assert.deepEqual(error.stdout.split("\0"), [mounted, `${mounted}/usr/lib:/existing path/lib:/another/lib`, "explicit argument", "--no-sandbox", ""]);
      return true;
    },
  );
});
