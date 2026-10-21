import { constants } from "node:fs";
import { mkdir, readFile, writeFile, rename, realpath, readdir, copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateWorkspace } from "../shared/core.mjs";

const DATA_FILES = ["workspace.json", "workspace.json.backup", "settings.json"];

function absoluteDirectory(directory, label = "数据目录") {
  if (typeof directory !== "string" || !directory.trim() || directory.includes("\0"))
    throw new Error(`${label}必须是有效的目录路径。`);
  return path.resolve(directory);
}

async function canonicalDirectory(directory) {
  let candidate = directory;
  const missing = [];
  while (true) {
    try { return path.join(await realpath(candidate), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function sameDirectory(first, second) {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function requireWorkspace(directory) {
  const failures = [];
  for (const filename of DATA_FILES.slice(0, 2)) {
    try {
      validateWorkspace(JSON.parse(await readFile(path.join(directory, filename), "utf8")));
      return;
    } catch (error) { failures.push(error); }
  }
  throw new Error("所选数据目录没有有效的 workspace.json 或 workspace.json.backup；原数据未修改。", { cause: failures[0] });
}

export async function readStorageConfig(profileDir, defaultDir) {
  const filename = path.join(absoluteDirectory(profileDir, "应用配置目录"), "storage.json");
  let raw;
  try { raw = await readFile(filename, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return absoluteDirectory(defaultDir);
    throw new Error(`数据目录配置读取失败，请检查 ${filename} 的访问权限。`, { cause: error });
  }
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)
        || typeof config.dataDirectory !== "string" || !path.isAbsolute(config.dataDirectory))
      throw new Error("dataDirectory 必须是绝对路径。");
    return absoluteDirectory(config.dataDirectory);
  } catch (error) {
    throw new Error(`数据目录配置无效，请保留并检查 ${filename} 中的 dataDirectory。`, { cause: error });
  }
}

/** Copy the three application files without moving or deleting the source directory. */
export async function prepareDataDirectory({ sourceDir, targetDir, mode }) {
  if (!["copy", "existing"].includes(mode)) throw new Error("数据目录操作必须为 copy 或 existing。");
  const source = absoluteDirectory(sourceDir);
  const target = absoluteDirectory(targetDir);
  const [canonicalSource, canonicalTarget] = await Promise.all([
    canonicalDirectory(source), canonicalDirectory(target),
  ]);
  if (sameDirectory(canonicalSource, canonicalTarget)) return target;
  if (mode === "existing") {
    await requireWorkspace(target);
    return target;
  }
  const relative = path.relative(canonicalSource, canonicalTarget);
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    throw new Error("新数据目录不能位于当前数据目录内部。请选择另一个空目录。");
  await requireWorkspace(source);
  try {
    const entries = await readdir(target);
    if (entries.length) throw new Error("目标目录不为空，无法复制以免覆盖已有数据。请选择空目录，或选择“使用已有数据”。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(target, { recursive: true });
  const copied = [];
  try {
    for (const filename of DATA_FILES) {
      try {
        await copyFile(path.join(source, filename), path.join(target, filename), constants.COPYFILE_EXCL);
        copied.push(path.join(target, filename));
      } catch (error) {
        // A recovered source can have only a backup, which remains a valid dataset.
        if (error.code === "ENOENT") continue;
        throw error;
      }
    }
    await requireWorkspace(target);
    return target;
  } catch (error) {
    // Only files created by this operation are removed; user and source files are untouched.
    await Promise.allSettled(copied.map((filename) => unlink(filename)));
    throw new Error("数据目录复制失败，原目录和配置仍保留。请检查目标目录权限及可用空间。", { cause: error });
  }
}

export async function writeStorageConfig(profileDir, directory) {
  const target = absoluteDirectory(directory);
  const profile = absoluteDirectory(profileDir, "应用配置目录");
  await mkdir(profile, { recursive: true });
  const filename = path.join(profile, "storage.json");
  const temporary = path.join(profile, `.storage-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ dataDirectory: target }, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    await rename(temporary, filename);
  } catch (error) {
    throw new Error("数据目录配置保存失败；原配置未被删除。请检查应用配置目录的访问权限。", { cause: error });
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return target;
}
