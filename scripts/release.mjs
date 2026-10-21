import { appendFile, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function validateTag(version, tag) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || tag !== `v${version}`)
    throw new Error(`Release tag must match package.json version: v${version}`);
  return tag;
}

export function expectedAssets(version) {
  return [
    "Portable.exe", "x64-Setup.exe", "mac-arm64.dmg", "mac-arm64.zip",
    "linux-amd64.deb", "linux-x86_64.rpm", "linux-x86_64.AppImage", "linux-x64.tar.gz",
  ].map((suffix) => `BranchLocal-${version}-${suffix}`);
}

export async function verifyAssets(directory, version) {
  const names = expectedAssets(version);
  for (const name of names) {
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.size === 0) throw new Error(`Invalid release package: ${name}`);
  }
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  validateTag(version, process.env.RELEASE_TAG);
  if (process.argv[2] === "version") {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=v${version}\n`);
    console.log(`Release v${version}`);
  } else if (process.argv[2] === "verify") {
    const names = await verifyAssets(path.join(root, "release"), version);
    console.log(`Verified ${names.length} release packages for v${version}`);
  } else {
    throw new Error("Expected version or verify command");
  }
}
