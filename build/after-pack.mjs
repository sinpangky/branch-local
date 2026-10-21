import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/** Keep Electron's sandbox enabled in AppImages, including extracted AppDirs. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  const executableName = context.packager.executableName;
  if (typeof executableName !== "string" || !executableName || /[\0/\\]/.test(executableName)
      || executableName === "." || executableName === "..")
    throw new Error("Linux executableName must be a non-empty filename.");
  const executable = `'${executableName.replaceAll("'", "'\\''")}'`;
  // electron-builder copies appOutDir over its generated AppRun when staging an
  // AppImage. This launcher therefore also replaces its automatic sandbox bypass.
  const launcher = `#!/bin/sh
set -eu

if [ -z "\${APPDIR:-}" ]; then
  case "$0" in
    /*) app_run="$0" ;;
    *) app_run="$PWD/$0" ;;
  esac
  APPDIR=$(CDPATH= cd -P "$(dirname "$app_run")" && pwd -P)
fi
export APPDIR
export PATH="$APPDIR:$APPDIR/usr/sbin\${PATH:+:$PATH}"
export XDG_DATA_DIRS="$APPDIR/usr/share/\${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}:/usr/share/gnome:/usr/local/share/:/usr/share/"
export LD_LIBRARY_PATH="$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GSETTINGS_SCHEMA_DIR="$APPDIR/usr/share/glib-2.0/schemas\${GSETTINGS_SCHEMA_DIR:+:$GSETTINGS_SCHEMA_DIR}"

exec "$APPDIR"/${executable} "$@"
`;
  const filename = path.join(context.appOutDir, "AppRun");
  await writeFile(filename, launcher, { encoding: "utf8", mode: 0o755 });
  await chmod(filename, 0o755);
}
