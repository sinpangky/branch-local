import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = process.argv[2] || metadata.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("Expected a release version such as 1.5.0");
const directory = path.join(root, "release");
const prefix = `BranchLocal-${version}-`;
const names = (await readdir(directory)).filter((name) =>
  name.startsWith(prefix) && /\.(?:exe|dmg|zip|AppImage|deb|rpm|tar\.gz)$/.test(name),
).sort();
if (!names.length) throw new Error(`No release packages for ${version}`);
const entries = [];
for (const name of names) {
  const filename = path.join(directory, name);
  const info = await stat(filename);
  if (!info.isFile()) continue;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  entries.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(path.join(directory, `SHA256SUMS-${version}.txt`), `${entries.join("\n")}\n`);
console.log(`SHA256SUMS-${version}.txt: ${entries.length} packages`);
