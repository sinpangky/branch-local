import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateWorkspace } from "../shared/core.mjs";

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Copy a legacy workspace once. Never modify either existing profile or source. */
export async function migrateLegacyData({ sourceDir, targetDir }) {
  await mkdir(targetDir, { recursive: true });
  if (path.resolve(sourceDir) === path.resolve(targetDir)) return false;
  if (
    (await exists(path.join(targetDir, "workspace.json"))) ||
    (await exists(path.join(targetDir, "workspace.json.backup")))
  )
    return false;
  let workspace = null;
  let found = false;
  for (const name of ["workspace.json", "workspace.json.backup"]) {
    try {
      const raw = await readFile(path.join(sourceDir, name), "utf8");
      found = true;
      workspace = validateWorkspace(JSON.parse(raw));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (["EACCES", "EPERM"].includes(error.code)) throw error;
        found = true;
      }
    }
  }
  if (!workspace) {
    if (!found) return false;
    throw new Error(
      "旧工作区和备份均无法读取。原文件保持不变，请先检查项目 data 目录。",
    );
  }
  try {
    await copyFile(
      path.join(sourceDir, "settings.json"),
      path.join(targetDir, "settings.json"),
      1,
    );
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
  }
  const content = `${JSON.stringify(workspace, null, 2)}\n`;
  try {
    await writeFile(path.join(targetDir, "workspace.json.backup"), content, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await writeFile(path.join(targetDir, "workspace.json"), content, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    path.join(targetDir, "migration.json"),
    JSON.stringify(
      { source: sourceDir, migratedAt: new Date().toISOString() },
      null,
      2,
    ),
    { flag: "wx" },
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return true;
}
