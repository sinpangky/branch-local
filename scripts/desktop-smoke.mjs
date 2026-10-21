import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "branch-desktop-smoke-"));
const report = path.join(profile, "result.json");
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : require("electron");
const args = process.argv[2] ? ["--self-test"] : [".", "--self-test"];
const child = spawn(executable, args, {
  cwd: root,
  env: {
    ...env,
    BRANCH_LOCAL_USER_DATA: profile,
    BRANCH_LOCAL_SMOKE_REPORT: report,
  },
  stdio: "pipe",
  windowsHide: true,
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});
const timer = setTimeout(() => {
  child.kill();
}, 45000);
const code = await new Promise((resolve) => child.on("exit", resolve));
clearTimeout(timer);
let result;
try {
  result = JSON.parse(await readFile(report, "utf8"));
} catch {
  throw new Error(
    `Desktop smoke did not produce a report (exit ${code}).\n${output}`,
  );
}
await mkdir(path.join(root, "artifacts"), { recursive: true });
await (
  await import("node:fs/promises")
).writeFile(
  path.join(root, "artifacts", "desktop-smoke.json"),
  JSON.stringify(result, null, 2),
);
if (
  !result.ok ||
  !result.applicationReady ||
  !result.nativeMaterialsImport ||
  !result.pdfMaterialExtraction ||
  !result.rendererSavedBeforeClose ||
  code !== 0
)
  throw new Error(`Desktop smoke failed: ${JSON.stringify(result)}\n${output}`);
console.log(
  `Desktop smoke passed: React workspace + sandbox preload + encrypted storage + save-before-close; no listening port.`,
);
