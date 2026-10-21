// Run with Electron to verify PDF.js and its local resources in the main process.
import { app } from "electron";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMaterialDocuments } from "../desktop/materials.mjs";
import { tinyMaterialPdf } from "./materials-fixture.mjs";

let directory;
const timer = setTimeout(() => { console.error("Electron PDF extraction timed out"); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  let code = 0;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "branch-materials-native-"));
    const filename = path.join(directory, "electron-reference.pdf");
    await writeFile(filename, tinyMaterialPdf([{ lines: ["Electron local reference"] }]));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("Material parsing must remain offline"); };
    let documents;
    try { documents = await readMaterialDocuments([filename]); }
    finally { globalThis.fetch = savedFetch; }
    assert.equal(documents[0].parts[0].text, "Electron local reference");
    assert.equal(documents[0].parts[0].page, 1);
    console.log(`Electron material extraction passed (Node ${process.versions.node}): PDF text and local font resources; no fetch.`);
  } catch (error) { console.error(error); code = 1; }
  finally {
    clearTimeout(timer);
    if (directory) {
      const resolved = path.resolve(directory);
      if (!resolved.startsWith(path.join(path.resolve(os.tmpdir()), "branch-materials-native-"))) {
        console.error("Refusing to remove unexpected native smoke directory");
        code = 1;
      } else await rm(resolved, { recursive: true, force: true });
    }
    app.exit(code);
  }
});
