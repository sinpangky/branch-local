import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MATERIAL_LIMITS, decodeMaterialText, normalizeMaterialText, splitMaterialText } from "../shared/materials.mjs";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

async function readBoundedFile(filename) {
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("请选择普通文件。");
    if (info.size > MATERIAL_LIMITS.fileBytes) throw new Error("单个文件不能超过 20 MiB。");
    const chunks = [];
    let total = 0;
    // The upper bound also protects against files that grow after stat().
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: MATERIAL_LIMITS.fileBytes })) {
      total += chunk.byteLength;
      if (total > MATERIAL_LIMITS.fileBytes) throw new Error("单个文件不能超过 20 MiB。");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

function countText(text, budget) {
  budget.textBytes += Buffer.byteLength(text, "utf8");
  if (budget.textBytes > MATERIAL_LIMITS.textBytes)
    throw new Error("本次导入的文字总量超过 1 MiB，请减少文件或拆分资料。");
}

async function extractPdf(bytes, budget) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new Error("文件不是有效的 PDF。");
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const libraryRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  const resourceDirectory = (name) => `${path.join(libraryRoot, name).replaceAll("\\", "/")}/`;
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    stopAtErrors: true,
    verbosity: 0,
    cMapUrl: resourceDirectory("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: resourceDirectory("standard_fonts"),
    wasmUrl: resourceDirectory("wasm"),
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void loadingTask.destroy().catch(() => {}); }, 30000);
  const parts = [];
  try {
    const document = await loadingTask.promise;
    budget.pages += document.numPages;
    if (budget.pages > MATERIAL_LIMITS.pages)
      throw new Error("本次导入的 PDF 总页数超过 500 页，请拆分资料后重试。");
    const imageOperators = new Set([
      OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
      OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat,
    ]);
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const reader = page.streamTextContent().getReader();
        const fragments = [];
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (typeof item.str !== "string") continue;
              const fragment = `${item.str}${item.hasEOL ? "\n" : " "}`;
              countText(fragment, budget);
              fragments.push(fragment);
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const text = normalizeMaterialText(fragments.join("")).replace(/[ \t]+\n/g, "\n").trim();
        if (!text) {
          const operators = await page.getOperatorList();
          if (operators.fnArray.some((operator) => imageOperators.has(operator)))
            throw new Error(`PDF 第 ${pageNumber} 页是图片扫描页，未发现可提取文字。当前不支持 OCR，请先识别文字后再导入。`);
          continue; // A genuinely blank page contributes no text.
        }
        for (const chunk of splitMaterialText(text)) parts.push({ page: pageNumber, text: chunk });
      } finally { page.cleanup(); }
    }
    if (!parts.length)
      throw new Error("PDF 未发现可提取文字，可能是图片扫描版或空白文档。当前不支持 OCR，请先识别文字后再导入。");
    return parts;
  } catch (error) {
    if (timedOut) throw new Error("PDF 文字提取超时，请拆分资料后重试。");
    if (error.name === "PasswordException") throw new Error("PDF 已加密，请先使用原应用解密后再导入。");
    if (["InvalidPDFException", "UnknownErrorException", "FormatError"].includes(error.name))
      throw new Error("PDF 无法解析，文件可能损坏或使用了不支持的格式。");
    throw error;
  } finally {
    clearTimeout(timer);
    await loadingTask.destroy();
  }
}

/** Only call with paths obtained from the native file picker, never renderer input. */
export async function readMaterialDocuments(filenames) {
  if (!Array.isArray(filenames) || !filenames.length || filenames.some((filename) => typeof filename !== "string"))
    throw new Error("请选择要导入的资料文件。");
  if (filenames.length > MATERIAL_LIMITS.files) throw new Error("一次最多导入 20 个资料文件。");
  const budget = { textBytes: 0, pages: 0 };
  const documents = [];
  for (const filename of filenames) {
    const name = path.basename(filename);
    try {
      if (!name || name.length > 255) throw new Error("资料文件名无效或过长。");
      const extension = path.extname(name).toLowerCase();
      if (extension !== ".pdf" && !TEXT_EXTENSIONS.has(extension))
        throw new Error("仅支持 Markdown、TXT 和 PDF 文件。");
      const bytes = await readBoundedFile(filename);
      if (extension === ".pdf") {
        documents.push({ name, kind: "pdf", parts: await extractPdf(bytes, budget) });
      } else {
        const text = decodeMaterialText(bytes);
        if (!text.trim()) throw new Error("文件没有可导入的文字。");
        countText(text, budget);
        documents.push({ name, kind: "markdown", parts: splitMaterialText(text).map((text) => ({ text })) });
      }
    } catch (error) {
      throw new Error(`“${name}”导入失败：${error.code ? "文件无法读取，请检查文件权限后重试。" : error.message}`);
    }
  }
  return documents;
}
