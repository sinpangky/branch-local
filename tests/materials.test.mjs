import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { MATERIAL_LIMITS, decodeMaterialText, normalizeMaterialText, splitMaterialText } from "../shared/materials.mjs";
import { readMaterialDocuments } from "../desktop/materials.mjs";
import { tinyMaterialPdf } from "./materials-fixture.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "branch-materials-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.join(path.resolve(os.tmpdir()), "branch-materials-test-")));
    await rm(resolved, { recursive: true, force: true });
  });
  return async (name, bytes) => {
    const filename = path.join(directory, name);
    await writeFile(filename, bytes);
    return filename;
  };
}

test("material splitting is lossless, bounded and preserves complete surrogate pairs", () => {
  const source = `${"a".repeat(79999)}😀\n${"b\n".repeat(45000)}`;
  const parts = splitMaterialText(source);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(""), source);
  for (const part of parts) {
    assert.ok(part.length <= MATERIAL_LIMITS.partLength);
    assert.doesNotMatch(part, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
  }
  assert.equal(normalizeMaterialText("\ufeff# title\r\n\r\n    code\r"), "# title\n\n    code\n");
  assert.throws(() => splitMaterialText("a", 0));
});

test("text decoding accepts UTF-8 and BOM UTF-16 while rejecting binary and invalid encodings", () => {
  assert.equal(decodeMaterialText(Buffer.from("中文 Markdown\r\n")), "中文 Markdown\n");
  assert.equal(decodeMaterialText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("本地资料", "utf16le")])), "本地资料");
  assert.equal(decodeMaterialText(Buffer.from([0xfe, 0xff, 0x00, 0x41])), "A");
  assert.throws(() => decodeMaterialText(Buffer.from([0x00, 0x01, 0x02])), /二进制/);
  assert.throws(() => decodeMaterialText(Buffer.from([0xff, 0x80, 0x80])), /编码/);
  assert.throws(() => decodeMaterialText(Buffer.from("%PDF-1.7\n")), /PDF 二进制/);
});

test("native materials preserve Markdown blocks, expose only base names, and split long text", async (t) => {
  const file = await fixture(t);
  const content = `# 资料\r\n\r\n    code\r\n${"测试内容".repeat(21000)}`;
  const documents = await readMaterialDocuments([
    await file("notes.MARKDOWN", content),
    await file("second.txt", "Another local reference"),
  ]);
  assert.equal(documents[0].name, "notes.MARKDOWN");
  assert.equal(documents[0].kind, "markdown");
  assert.equal(documents[0].parts.map((part) => part.text).join(""), normalizeMaterialText(content));
  assert.ok(documents[0].parts.length > 1);
  assert.ok(documents[0].parts.every((part) => !Object.hasOwn(part, "page") && part.text.length <= MATERIAL_LIMITS.partLength));
  assert.equal(documents[1].parts[0].text, "Another local reference");
  assert.equal(JSON.stringify(documents).includes(path.dirname(await file("unused.txt", "x"))), false);
});

test("a real local PDF extracts ordered page text without any fetch calls", async (t) => {
  const file = await fixture(t);
  const filename = await file("reference.pdf", tinyMaterialPdf([
    { lines: ["First page", "Local reference text"] },
    { lines: ["Second page", "Independent text"] },
  ]));
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("No network is allowed in material extraction"); };
  let documents;
  try { documents = await readMaterialDocuments([filename]); }
  finally { globalThis.fetch = savedFetch; }
  assert.equal(documents[0].kind, "pdf");
  assert.deepEqual(documents[0].parts.map((part) => part.page), [1, 2]);
  assert.equal(documents[0].parts[0].text, "First page\nLocal reference text");
  assert.equal(documents[0].parts[1].text, "Second page\nIndependent text");
});

test("large PDF pages split into bounded parts and retain their original page number", async (t) => {
  const file = await fixture(t);
  const text = "PDF reference ".repeat(7000);
  const [document] = await readMaterialDocuments([await file("long-page.pdf", tinyMaterialPdf([{ lines: [text], fontSize: 0.001 }]))]);
  assert.ok(document.parts.length > 1);
  assert.ok(document.parts.every((part) => part.page === 1 && part.text.length <= MATERIAL_LIMITS.partLength));
  assert.equal(document.parts.map((part) => part.text).join(""), text.trim());
});

test("scanned PDFs fail explicitly, including a scanned page after a text page", async (t) => {
  const file = await fixture(t);
  await assert.rejects(() => readMaterialDocuments([]), /请选择/);
  for (const [index, pages] of [[0, [{ image: true }]], [1, [{ lines: ["Readable first page"] }, { image: true }]]]) {
    const filename = await file(`scanned-${index}.pdf`, tinyMaterialPdf(pages));
    await assert.rejects(() => readMaterialDocuments([filename]), /扫描页.*不支持 OCR/);
  }
  const blank = await file("blank.pdf", tinyMaterialPdf([{ lines: [] }]));
  await assert.rejects(() => readMaterialDocuments([blank]), /未发现可提取文字.*不支持 OCR/);
});

test("material limits fail the entire import without silent truncation", async (t) => {
  const file = await fixture(t);
  const one = await file("one.md", "x".repeat(700000));
  const two = await file("two.md", "y".repeat(400000));
  await assert.rejects(() => readMaterialDocuments([one, two]), /总量超过 1 MiB/);
  await assert.rejects(() => readMaterialDocuments(Array.from({ length: 21 }, () => one)), /最多导入 20/);
  const oversized = await file("oversized.pdf", "");
  const handle = await open(oversized, "r+");
  await handle.truncate(MATERIAL_LIMITS.fileBytes + 1);
  await handle.close();
  await assert.rejects(() => readMaterialDocuments([oversized]), /不能超过 20 MiB/);
  const manyPages = await file("many-pages.pdf", tinyMaterialPdf(Array.from({ length: 501 }, () => ({ lines: ["Text"] }))));
  await assert.rejects(() => readMaterialDocuments([manyPages]), /总页数超过 500/);
});

test("material imports reject unsupported, empty, binary and damaged source files", async (t) => {
  const file = await fixture(t);
  for (const [name, content, message] of [
    ["not-supported.docx", "text", /仅支持/],
    ["empty.md", " \n\t", /没有可导入的文字/],
    ["binary.md", Buffer.from([0x00, 0x01, 0x02]), /二进制/],
    ["fake.pdf", "plain text", /不是有效的 PDF/],
    ["damaged.pdf", "%PDF-1.7\nnot a real document", /无法解析/],
  ]) {
    const filename = await file(name, content);
    await assert.rejects(() => readMaterialDocuments([filename]), message);
  }
});

test("sandbox preload exposes material import without accepting renderer paths", async () => {
  const calls = [];
  let bridge;
  vm.runInNewContext(await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ canceled: true, documents: [] }); } },
    }),
    process: { platform: "win32" },
    window: { addEventListener() {} },
  });
  await bridge.importMaterials("C:\\renderer-cannot-read.txt");
  assert.deepEqual(calls, [["desktop:import-materials"]]);
});
