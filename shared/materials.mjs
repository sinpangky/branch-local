export const MATERIAL_LIMITS = Object.freeze({
  files: 20,
  fileBytes: 20 * 1024 * 1024,
  textBytes: 1024 * 1024,
  pages: 500,
  partLength: 80000,
});

/** Split without dropping whitespace or cutting a UTF-16 surrogate pair. */
export function splitMaterialText(text, maximum = MATERIAL_LIMITS.partLength) {
  if (typeof text !== "string" || !Number.isSafeInteger(maximum) || maximum < 2)
    throw new Error("资料文本或分块大小无效。");
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maximum);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= offset + Math.floor(maximum * 0.75)) end = newline + 1;
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

export function normalizeMaterialText(text) {
  if (typeof text !== "string") throw new Error("资料文本无效。");
  // Retain Markdown indentation and code blocks; normalize only line endings/BOM.
  return text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
}

export function decodeMaterialText(bytes) {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-")
    throw new Error("文件包含 PDF 二进制内容，请使用 .pdf 扩展名导入。");
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error("文本编码无法识别，请将文件另存为 UTF-8 或带 BOM 的 UTF-16 后重试。"); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text))
    throw new Error("文件包含二进制数据，无法作为 Markdown 或文本导入。");
  return normalizeMaterialText(text);
}
