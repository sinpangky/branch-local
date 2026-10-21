import path from "node:path";

export const APP_URL = "branch-local://app/";

export function isAppUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "branch-local:" &&
      url.hostname === "app" &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function assetFilename(root, value) {
  if (!isAppUrl(value)) throw new Error("Invalid application URL");
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(value).pathname);
  } catch {
    throw new Error("Invalid resource path");
  }
  if (
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.split("/").includes("..")
  )
    throw new Error("Invalid resource path");
  const filename = path.resolve(
    root,
    `.${pathname === "/" ? "/index.html" : pathname}`,
  );
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Invalid resource path");
  return filename;
}

export function safeFilename(value) {
  if (typeof value !== "string") throw new Error("文件名无效。");
  const name = value
    .split(/[\\/]/)
    .at(-1)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/, "")
    .slice(0, 160);
  if (!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    return "枝间-导出.json";
  return name;
}

export function restoreBounds(value, displays) {
  const fallback = { width: 1440, height: 940 };
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height))
    return fallback;
  const bounds = {
    width: Math.max(980, Math.min(3840, Math.round(value.width))),
    height: Math.max(640, Math.min(2160, Math.round(value.height))),
  };
  if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
    const onScreen = displays.some(
      ({ workArea: area }) =>
        value.x + bounds.width > area.x + 100 &&
        value.x < area.x + area.width - 100 &&
        value.y + 60 > area.y &&
        value.y < area.y + area.height - 60,
    );
    if (onScreen) {
      bounds.x = Math.round(value.x);
      bounds.y = Math.round(value.y);
    }
  }
  return bounds;
}
