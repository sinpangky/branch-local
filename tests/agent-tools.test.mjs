import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AGENT_TOOLS, createAgentTools } from "../server/agent-tools.mjs";

const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];
async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "branch-agent-tools-"));
  const root = path.join(base, "workspace");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 3 }));
  return { base, root, agent: await createAgentTools({ root, lookupImpl: publicLookup, ...options }) };
}
const perform = async (agent, name, args, options) => (await agent.prepare(name, args, options)).execute();

test("tool registry is engine independent and optional command/network capabilities are absent by default", async (t) => {
  const { agent } = await fixture(t);
  assert.equal(AGENT_TOOLS.length, 10);
  assert.deepEqual(agent.tools.map((tool) => tool.function.name), ["list_files", "read_file", "search_files", "write_file", "edit_file", "create_directory"]);
  for (const name of ["run_command", "fetch_url", "download_file", "web_search", "unknown"]) await assert.rejects(agent.prepare(name), /未启用/);
  for (const tool of AGENT_TOOLS) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.doesNotThrow(() => JSON.stringify(tool));
  }
});

test("selected root must be an existing absolute directory", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(createAgentTools({ root: "." }), /绝对工作目录/);
  await assert.rejects(createAgentTools({ root: path.join(root, "absent") }), /ENOENT/);
  await writeFile(path.join(root, "file.txt"), "a");
  await assert.rejects(createAgentTools({ root: path.join(root, "file.txt") }), /不是目录/);
});

test("file reads and recursive text search retain paths, line numbers and UTF-8 content", async (t) => {
  const { root, agent } = await fixture(t);
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "你好.md"), "第一行\r\nNeedle 与公式\nneedle second");
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  const listing = await perform(agent, "list_files", { recursive: true });
  assert.deepEqual(new Set(listing.entries.map((entry) => entry.path)), new Set(["notes", "notes/你好.md", "binary.bin"]));
  const read = await perform(agent, "read_file", { path: "notes/你好.md" });
  assert.equal(read.content, "第一行\r\nNeedle 与公式\nneedle second");
  assert.match(read.hash, /^[0-9a-f]{64}$/);
  const search = await perform(agent, "search_files", { query: "needle" });
  assert.deepEqual(search.matches.map(({ path: file, line }) => [file, line]), [["notes/你好.md", 2], ["notes/你好.md", 3]]);
  assert.equal(search.skipped, 1);
  const sensitive = await perform(agent, "search_files", { query: "Needle", case_sensitive: true });
  assert.equal(sensitive.matches.length, 1);
  assert.doesNotThrow(() => JSON.stringify(search));
});

test("paths reject traversal, absolute/UNC/ADS paths and platform-specific ambiguous names", async (t) => {
  const { root, agent } = await fixture(t);
  for (const file of ["../outside", "sub/../../outside", root, "C:\\Windows\\a.txt", "\\\\server\\share\\a", "/etc/passwd", "a.txt:stream", "a\0.txt", "CON", "aux.txt", "a.", "a ", "a?.txt"]) {
    await assert.rejects(agent.prepare("read_file", { path: file }), undefined, file);
  }
  await assert.rejects(agent.prepare("read_file", { path: 5 }), /路径/);
});

test("read_file ranges preserve original newlines and full-file hashes while exposing omitted context", async (t) => {
  const { root, agent } = await fixture(t);
  await writeFile(path.join(root, "lines.txt"), Array.from({ length: 250 }, (_, index) => `第 ${index + 1} 行\r\n`).join(""));
  const first = await perform(agent, "read_file", { path: "lines.txt" });
  assert.equal(first.total_lines, 250); assert.equal(first.start_line, 1); assert.equal(first.end_line, 200);
  assert.equal(first.truncated, true); assert.equal(first.content_truncated, false);
  assert.equal(first.content.split("\r\n").length, 201);
  const rest = await perform(agent, "read_file", { path: "lines.txt", start_line: 201, end_line: 1000 });
  assert.equal(rest.hash, first.hash); assert.equal(rest.start_line, 201); assert.equal(rest.end_line, 250);
  assert.equal(rest.content, Array.from({ length: 50 }, (_, index) => `第 ${index + 201} 行\r\n`).join(""));
  assert.equal(rest.truncated, true); // Earlier lines are intentionally absent from this result.
  const all = await perform(agent, "read_file", { path: "lines.txt", end_line: 250 });
  assert.equal(all.truncated, false);
  await writeFile(path.join(root, "cr.txt"), "a\rb\rc");
  const cr = await perform(agent, "read_file", { path: "cr.txt", start_line: 2, end_line: 2 });
  assert.equal(cr.content, "b\r"); assert.equal(cr.total_lines, 3);
});

test("read_file validates line bounds, handles empty files and caps long lines without splitting Unicode", async (t) => {
  const { root, agent } = await fixture(t);
  await writeFile(path.join(root, "empty.txt"), "");
  const empty = await perform(agent, "read_file", { path: "empty.txt" });
  assert.equal(empty.content, ""); assert.equal(empty.total_lines, 0); assert.equal(empty.start_line, 0); assert.equal(empty.end_line, 0); assert.equal(empty.truncated, false);
  for (const range of [{ start_line: 0 }, { start_line: 1.5 }, { end_line: "2" }, { start_line: 3, end_line: 2 }, { end_line: 1001 }, { start_line: 1024 * 1024 + 2 }]) {
    await assert.rejects(agent.prepare("read_file", { path: "empty.txt", ...range }), /读取范围/);
  }
  await assert.rejects(perform(agent, "read_file", { path: "empty.txt", start_line: 2 }), /超出文件范围/);
  await writeFile(path.join(root, "long.txt"), "x".repeat(79999) + "😀" + "tail\nsecond");
  const long = await perform(agent, "read_file", { path: "long.txt" });
  assert.equal(long.content.length, 79999); assert.equal(long.content.isWellFormed(), true);
  assert.equal(long.total_lines, 2); assert.equal(long.end_line, 1); assert.equal(long.truncated, true); assert.equal(long.content_truncated, true);
  assert.deepEqual(long.next_read, { path: "long.txt", start_line: 1, end_line: 200, offset: 79999 });
  const continuation = await perform(agent, "read_file", long.next_read);
  assert.equal(long.content + continuation.content, "x".repeat(79999) + "😀" + "tail\nsecond");
  assert.equal(continuation.content.isWellFormed(), true); assert.equal(continuation.start_line, 1); assert.equal(continuation.end_line, 2);
  assert.equal(continuation.content_truncated, false); assert.equal(continuation.next_read, undefined); assert.equal(continuation.truncated, true);
  await assert.rejects(perform(agent, "read_file", { path: "long.txt", offset: 80000 }), /代理对/);
  const second = await perform(agent, "read_file", { path: "long.txt", start_line: 2 });
  assert.equal(second.content, "second"); assert.equal(second.hash, long.hash);
});

test("read_file continuation reconstructs a long single-line JSON without command access", async (t) => {
  const { root, agent } = await fixture(t);
  const original = JSON.stringify({ data: "x".repeat(90000), tail: "最终内容 😀" });
  await writeFile(path.join(root, "long.json"), original);
  assert.equal(agent.tools.some((tool) => tool.function.name === "run_command"), false);
  const first = await perform(agent, "read_file", { path: "long.json" });
  assert.equal(first.content.length, 80000); assert.equal(first.content_truncated, true);
  assert.equal(first.start_line, 1); assert.equal(first.end_line, 1);
  const last = await perform(agent, "read_file", first.next_read);
  assert.equal(last.hash, first.hash); assert.equal(last.start_line, 1); assert.equal(last.end_line, 1);
  assert.equal(last.content_truncated, false); assert.equal(last.next_read, undefined); assert.equal(last.truncated, true);
  assert.equal(first.content + last.content, original);
  assert.equal(JSON.parse(first.content + last.content).tail, "最终内容 😀");
});

test("read_file continuation tracks actual multiline ranges and retains original block parameters", async (t) => {
  const { root, agent } = await fixture(t);
  const block = Array.from({ length: 8 }, (_, index) => `${index}:` + "x".repeat(29998) + "\r\n").join("");
  const original = "before\n" + block + "after";
  await writeFile(path.join(root, "blocks.txt"), original);
  let args = { path: "blocks.txt", start_line: 2, end_line: 9 }; const pages = [];
  do {
    const read = await perform(agent, "read_file", args); pages.push(read);
    assert.equal(read.total_lines, 10); assert.equal(read.truncated, true); assert.equal(read.content.isWellFormed(), true);
    if (read.next_read) {
      assert.equal(read.next_read.start_line, 2); assert.equal(read.next_read.end_line, 9);
      assert.equal(read.next_read.offset, (args.offset || 0) + read.content.length);
    }
    args = read.next_read;
  } while (args);
  assert.equal(pages.map((page) => page.content).join(""), block);
  assert.deepEqual(pages.map((page) => [page.start_line, page.end_line]), [[2, 4], [4, 7], [7, 9], [9, 9]]);
  assert.ok(pages.every((page) => page.hash === pages[0].hash));
  const before = await perform(agent, "read_file", { path: "blocks.txt", end_line: 1 });
  const after = await perform(agent, "read_file", { path: "blocks.txt", start_line: 10 });
  assert.equal(before.content + pages.map((page) => page.content).join("") + after.content, original);
  const crlf = await perform(agent, "read_file", { path: "blocks.txt", start_line: 2, end_line: 2, offset: 30001 });
  assert.equal(crlf.content, "\n"); assert.equal(crlf.start_line, 2); assert.equal(crlf.end_line, 2);
});

test("read_file rejects invalid block offsets and handles exact block-end offsets", async (t) => {
  const { root, agent } = await fixture(t);
  await writeFile(path.join(root, "file.txt"), "abc\ndef");
  for (const offset of [-1, 0.5, "1", null, NaN, Infinity, 1024 * 1024 + 1]) {
    await assert.rejects(agent.prepare("read_file", { path: "file.txt", offset }), /offset/);
  }
  await assert.rejects(perform(agent, "read_file", { path: "file.txt", end_line: 1, offset: 5 }), /超出所选行块/);
  const empty = await perform(agent, "read_file", { path: "file.txt", offset: 7 });
  assert.equal(empty.content, ""); assert.equal(empty.start_line, 0); assert.equal(empty.end_line, 0);
  assert.equal(empty.truncated, true); assert.equal(empty.content_truncated, false); assert.equal(empty.next_read, undefined);
  const nextLine = await perform(agent, "read_file", { path: "file.txt", offset: 4 });
  assert.equal(nextLine.content, "def"); assert.equal(nextLine.start_line, 2); assert.equal(nextLine.end_line, 2);
});

test("dependency, repository, environment and credential files are excluded from listing, search and direct access", async (t) => {
  const { root, agent } = await fixture(t);
  for (const folder of ["node_modules", ".git", ".ssh", ".aws"]) {
    await mkdir(path.join(root, folder)); await writeFile(path.join(root, folder, "private.txt"), "PRIVATE");
    await assert.rejects(agent.prepare("read_file", { path: `${folder}/private.txt` }), /默认排除/);
  }
  for (const file of [".env", ".env.local", "api-key.txt", "credentials.json", "secret.pem", "id_ed25519", ".npmrc", "token.json"]) {
    await writeFile(path.join(root, file), "PRIVATE");
    await assert.rejects(agent.prepare("read_file", { path: file }), /默认排除/);
    await assert.rejects(agent.prepare("write_file", { path: file, content: "new" }), /默认排除/);
  }
  assert.deepEqual((await perform(agent, "list_files", { recursive: true })).entries, []);
  assert.deepEqual((await perform(agent, "search_files", { query: "PRIVATE" })).matches, []);
});

test("directory junctions cannot escape root or enter recursive traversal", async (t) => {
  const { base, root, agent } = await fixture(t);
  const outside = path.join(base, "outside"); await mkdir(outside); await writeFile(path.join(outside, "private.txt"), "outside");
  try { await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "ENOSYS"].includes(error.code)) return t.skip("symlink permission unavailable"); throw error; }
  await assert.rejects(agent.prepare("read_file", { path: "linked/private.txt" }), /符号链接|联接/);
  await assert.rejects(agent.prepare("write_file", { path: "linked/created.txt", content: "new" }), /符号链接|联接/);
  assert.deepEqual((await perform(agent, "list_files", { recursive: true })).entries, []);
});

test("non-UTF8, binary and oversized files are not read or replaced as text", async (t) => {
  const { root, agent } = await fixture(t);
  const files = [["nul.bin", Buffer.from([0, 1])], ["invalid.txt", Buffer.from([0xff, 0xfe])], ["large.txt", Buffer.alloc(1024 * 1024 + 1, 65)]];
  for (const [file, data] of files) {
    await writeFile(path.join(root, file), data);
    await assert.rejects(perform(agent, "read_file", { path: file }));
    await assert.rejects(agent.prepare("write_file", { path: file, content: "replacement" }));
    assert.deepEqual(await readFile(path.join(root, file)), data);
  }
  await assert.rejects(agent.prepare("write_file", { path: "new.txt", content: "a".repeat(1024 * 1024 + 1) }), /1 MiB/);
  await assert.rejects(agent.prepare("write_file", { path: "new.txt", content: null }), /UTF-8/);
});

test("write previews do not modify disk; execution atomically creates/replaces with exact reviewed contents", async (t) => {
  const { root, agent } = await fixture(t);
  await writeFile(path.join(root, "notes.md"), "before");
  const approval = await agent.prepare("write_file", { path: "notes.md", content: "after 中文" });
  assert.equal(approval.requiresApproval, true);
  assert.deepEqual(approval.preview, { kind: "write", path: "notes.md", before: "before", after: "after 中文", exists: true });
  assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "before");
  assert.equal((await approval.execute()).written, true);
  assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "after 中文");
  const create = await agent.prepare("write_file", { path: "empty.md", content: "" });
  assert.equal(create.preview.exists, false);
  await create.execute();
  assert.equal(await readFile(path.join(root, "empty.md"), "utf8"), "");
  assert.equal((await readdir(root)).some((name) => name.startsWith(".branch-agent-")), false);
});

test("write approvals cannot overwrite an intervening create, edit or deletion", async (t) => {
  const { root, agent } = await fixture(t);
  const original = path.join(root, "file.md"); await writeFile(original, "original");
  const edit = await agent.prepare("write_file", { path: "file.md", content: "approved" });
  await writeFile(original, "user changed");
  await assert.rejects(edit.execute(), /审批后文件已变化/);
  assert.equal(await readFile(original, "utf8"), "user changed");
  const missing = await agent.prepare("write_file", { path: "new.md", content: "approved" });
  await writeFile(path.join(root, "new.md"), "intervening");
  await assert.rejects(missing.execute(), /审批后文件已变化/);
  const removed = await agent.prepare("write_file", { path: "file.md", content: "approved" });
  await rm(original);
  await assert.rejects(removed.execute(), /ENOENT/);
  await assert.rejects(agent.prepare("write_file", { path: "missing-parent/new.md", content: "x" }), /ENOENT/);
});

test("edit_file previews exact targeted changes, supports literal replacements and preserves surrounding content", async (t) => {
  const { root, agent } = await fixture(t);
  const before = "title 中文\r\nconst value = 1;\r\nunchanged 😀\r\n";
  await writeFile(path.join(root, "code.txt"), before);
  const edit = await agent.prepare("edit_file", { path: "code.txt", old_text: "const value = 1;", new_text: "const value = '$& $` $1';" });
  assert.equal(edit.requiresApproval, true); assert.equal(edit.preview.kind, "write");
  assert.equal(edit.preview.before, before); assert.equal(edit.preview.replacements, 1);
  assert.equal(await readFile(path.join(root, "code.txt"), "utf8"), before);
  const result = await edit.execute();
  assert.equal(result.replacements, 1); assert.equal(result.written, true);
  assert.equal(await readFile(path.join(root, "code.txt"), "utf8"), "title 中文\r\nconst value = '$& $` $1';\r\nunchanged 😀\r\n");
  assert.equal(result.bytes, Buffer.byteLength(edit.preview.after));
  await perform(agent, "edit_file", { path: "code.txt", old_text: "title 中文\r\n", new_text: "" });
  assert.equal((await readFile(path.join(root, "code.txt"), "utf8")).startsWith("const value"), true);
  await writeFile(path.join(root, "bom.txt"), Buffer.from("\ufefftitle\r\noriginal\r\n", "utf8"));
  await perform(agent, "edit_file", { path: "bom.txt", old_text: "original", new_text: "changed" });
  assert.deepEqual(await readFile(path.join(root, "bom.txt")), Buffer.from("\ufefftitle\r\nchanged\r\n", "utf8"));
});

test("edit_file rejects missing, ambiguous and overlapping matches unless replace_all is explicitly selected", async (t) => {
  const { root, agent } = await fixture(t);
  const target = path.join(root, "file.txt"); await writeFile(target, "one\r\none\r\naaa");
  for (const oldText of ["missing", "one", "aa"]) {
    await assert.rejects(agent.prepare("edit_file", { path: "file.txt", old_text: oldText, new_text: "new" }), /未精确匹配|歧义/);
  }
  assert.equal(await readFile(target, "utf8"), "one\r\none\r\naaa");
  const replace = await agent.prepare("edit_file", { path: "file.txt", old_text: "one", new_text: "two", replace_all: true });
  assert.equal(replace.preview.replacements, 2); await replace.execute();
  assert.equal(await readFile(target, "utf8"), "two\r\ntwo\r\naaa");
  await assert.rejects(agent.prepare("edit_file", { path: "file.txt", old_text: "two\ntwo", new_text: "x" }), /未精确匹配/);
  await assert.rejects(agent.prepare("edit_file", { path: "absent.txt", old_text: "x", new_text: "y" }), /ENOENT/);
  for (const invalid of [{ old_text: "" }, { old_text: null }, { new_text: null }, { replace_all: "true" }, { new_text: "\0" }, { new_text: "\ud800" }]) {
    await assert.rejects(agent.prepare("edit_file", { path: "file.txt", old_text: "two", new_text: "x", ...invalid }), /old_text|new_text|replace_all/);
  }
});

test("edit_file rejects oversized expansion before allocating or writing and respects approval-time file changes", async (t) => {
  const { root, agent } = await fixture(t);
  const target = path.join(root, "file.txt"); await writeFile(target, "a".repeat(2000));
  await assert.rejects(agent.prepare("edit_file", { path: "file.txt", old_text: "a", new_text: "b".repeat(1024 * 1024), replace_all: true }), /超过 1 MiB/);
  assert.equal((await readFile(target)).length, 2000);
  await writeFile(target, "before");
  const edit = await agent.prepare("edit_file", { path: "file.txt", old_text: "before", new_text: "after" });
  await writeFile(target, "user edit");
  await assert.rejects(edit.execute(), /审批后文件已变化/);
  assert.equal(await readFile(target, "utf8"), "user edit");
  const deleted = await agent.prepare("edit_file", { path: "file.txt", old_text: "user edit", new_text: "after" });
  await rm(target); await assert.rejects(deleted.execute(), /ENOENT/);
  assert.equal((await readdir(root)).some((name) => name.startsWith(".branch-agent-")), false);
});

test("create_directory requires approval, creates one level and never overwrites an existing target", async (t) => {
  const { root, agent } = await fixture(t);
  const create = await agent.prepare("create_directory", { path: "notes" });
  assert.equal(create.requiresApproval, true);
  assert.deepEqual(create.preview, { kind: "directory", path: "notes", recursive: false });
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await create.execute(), { path: "notes", created: true });
  await perform(agent, "create_directory", { path: "notes/research" });
  await perform(agent, "write_file", { path: "notes/research/new.md", content: "new" });
  await assert.rejects(agent.prepare("create_directory", { path: "notes" }), /已存在/);
  await assert.rejects(agent.prepare("create_directory", { path: "notes/research/new.md" }), /已存在/);
  await assert.rejects(agent.prepare("create_directory", { path: "absent/child" }), /ENOENT/);
  assert.equal(await readFile(path.join(root, "notes/research/new.md"), "utf8"), "new");
});

test("create_directory rejects unsafe paths and rechecks intervening creates, parent replacement and cancellation", async (t) => {
  const { root, agent } = await fixture(t);
  for (const relative of ["../outside", "C:\\new", ".git", "notes/.env.local", "secret.pem", "CON", "notes:stream"]) {
    await assert.rejects(agent.prepare("create_directory", { path: relative }));
  }
  const raced = await agent.prepare("create_directory", { path: "raced" });
  await writeFile(path.join(root, "raced"), "user file");
  await assert.rejects(raced.execute(), /已存在/);
  assert.equal(await readFile(path.join(root, "raced"), "utf8"), "user file");
  await mkdir(path.join(root, "parent"));
  const replaced = await agent.prepare("create_directory", { path: "parent/child" });
  await rename(path.join(root, "parent"), path.join(root, "original-parent")); await mkdir(path.join(root, "parent"));
  await assert.rejects(replaced.execute(), /父目录已变化/);
  assert.deepEqual(await readdir(path.join(root, "parent")), []);
  const controller = new AbortController();
  const cancelled = await agent.prepare("create_directory", { path: "cancelled" }, { signal: controller.signal }); controller.abort();
  await assert.rejects(cancelled.execute(), /取消/);
  assert.deepEqual(new Set(await readdir(root)), new Set(["raced", "parent", "original-parent"]));
});

test("prepared file operations revalidate a replaced ancestor before executing", async (t) => {
  const { root, base, agent } = await fixture(t);
  const folder = path.join(root, "child"); await mkdir(folder); await writeFile(path.join(folder, "file.txt"), "inside");
  const read = await agent.prepare("read_file", { path: "child/file.txt" });
  const write = await agent.prepare("write_file", { path: "child/file.txt", content: "new" });
  const edit = await agent.prepare("edit_file", { path: "child/file.txt", old_text: "inside", new_text: "new" });
  const create = await agent.prepare("create_directory", { path: "child/new-folder" });
  const outside = path.join(base, "outside"); await mkdir(outside); await writeFile(path.join(outside, "file.txt"), "outside");
  await rm(folder, { recursive: true });
  try { await symlink(outside, folder, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "ENOSYS"].includes(error.code)) return t.skip("symlink permission unavailable"); throw error; }
  await assert.rejects(read.execute(), /符号链接|联接/);
  await assert.rejects(write.execute(), /符号链接|联接/);
  await assert.rejects(edit.execute(), /符号链接|联接/);
  await assert.rejects(create.execute(), /符号链接|联接/);
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside");
  assert.deepEqual(await readdir(outside), ["file.txt"]);
});

test("search and list outputs are bounded and cancellation stops traversal", async (t) => {
  const { root, agent } = await fixture(t);
  await writeFile(path.join(root, "many.txt"), "needle ".repeat(1000) + "\n" + "needle\n".repeat(130));
  const result = await perform(agent, "search_files", { query: "needle" });
  assert.equal(result.matches.length, 100); assert.equal(result.matches[0].text.length, 500); assert.equal(result.truncated, true);
  const controller = new AbortController();
  const prepared = await agent.prepare("list_files", {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(prepared.execute(), /取消/);
  await assert.rejects(agent.prepare("read_file", { path: "many.txt" }, { signal: controller.signal }), /取消/);
});

test("command execution requires opt-in and approval, exposes unsandboxed privilege, and preserves exact command", async (t) => {
  const { root, agent } = await fixture(t, { allowCommands: true });
  const commandTool = agent.tools.find((tool) => tool.function.name === "run_command");
  const shellDescription = commandTool.function.parameters.properties.command.description;
  assert.match(shellDescription, process.platform === "win32" ? /PowerShell.*powershell\.exe/ : /POSIX sh.*\/bin\/sh/);
  const command = process.platform === "win32" ? "Write-Output 'fixture-output'; exit 3" : "printf fixture-output; exit 3";
  const prepared = await agent.prepare("run_command", { command, timeout_ms: 10000 });
  assert.equal(prepared.requiresApproval, true); assert.equal(prepared.preview.command, command); assert.equal(prepared.preview.sandboxed, false);
  assert.match(prepared.preview.warning, /工作目录之外/);
  assert.equal(prepared.preview.cwd, ".");
  const result = await prepared.execute();
  assert.equal(result.exitCode, 3); assert.match(result.stdout, /fixture-output/); assert.equal(result.timedOut, false);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(agent.prepare("run_command", { command: "x", cwd: ".." }), /上级目录/);
  await assert.rejects(agent.prepare("run_command", { command: "x", timeout_ms: 1 }), /超时/);
});

test("commands cap combined output and terminate on timeout or cancellation", async (t) => {
  const { agent } = await fixture(t, { allowCommands: true });
  const flood = process.platform === "win32" ? "Write-Output ('x' * 150000)" : "head -c 150000 /dev/zero | tr '\\0' x";
  const output = await perform(agent, "run_command", { command: flood, timeout_ms: 10000 });
  assert.equal(output.truncated, true); assert.ok(Buffer.byteLength(output.stdout + output.stderr) <= 128 * 1024);
  const wait = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
  const timed = await perform(agent, "run_command", { command: wait, timeout_ms: 150 });
  assert.equal(timed.timedOut, true);
  const controller = new AbortController();
  const prepared = await agent.prepare("run_command", { command: wait, timeout_ms: 10000 }, { signal: controller.signal });
  const running = prepared.execute(); setTimeout(() => controller.abort(), 150);
  assert.equal((await running).cancelled, true);
});

test("network tools are separately enabled and searches require a configured endpoint", async (t) => {
  const { agent } = await fixture(t, { allowNetwork: true });
  assert.ok(agent.tools.some((tool) => tool.function.name === "fetch_url"));
  assert.ok(agent.tools.some((tool) => tool.function.name === "download_file"));
  assert.ok(!agent.tools.some((tool) => tool.function.name === "web_search"));
});

test("network blocks non-HTTPS, credentials, alternate ports and private/reserved literal IPs before fetching", async (t) => {
  let calls = 0;
  const { agent } = await fixture(t, { allowNetwork: true, fetchImpl: async () => { calls += 1; return new Response("oops"); } });
  for (const url of ["http://example.com", "file:///a", "https://name:password@example.com", "https://example.com:444", "https://localhost", "https://host.local", "https://127.0.0.1", "https://10.1.2.3", "https://100.64.0.1", "https://169.254.169.254", "https://172.16.1.2", "https://192.168.1.2", "https://198.18.0.1", "https://[::1]", "https://[fc00::1]", "https://[::ffff:127.0.0.1]", "https://[2001:db8::1]", "https://[2001::1]", "https://[2001:2::1]"]) {
    await assert.rejects(agent.prepare("fetch_url", { url }), undefined, url);
  }
  assert.equal(calls, 0);
});

test("all DNS answers and every redirect are checked before requests", async (t) => {
  let calls = 0;
  const lookupImpl = async (host) => host === "mixed.test" ? [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] : await publicLookup();
  const { agent } = await fixture(t, { allowNetwork: true, lookupImpl, fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/metadata" } }); } });
  await assert.rejects(agent.prepare("fetch_url", { url: "https://mixed.test" }), /私网/);
  assert.equal(calls, 0);
  await assert.rejects(perform(agent, "fetch_url", { url: "https://public.test" }), /私网/);
  assert.equal(calls, 1);
});

test("network preparation can be cancelled while DNS is unresolved", async (t) => {
  const controller = new AbortController();
  const { agent } = await fixture(t, { allowNetwork: true, lookupImpl: () => new Promise(() => {}), fetchImpl: async () => { throw new Error("must not fetch"); } });
  const preparing = agent.prepare("fetch_url", { url: "https://unresolved.test" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(preparing, /取消/);
});

test("fetch GETs public text without model credentials, strips scripts and bounds readable output", async (t) => {
  const requests = [];
  const { agent } = await fixture(t, { allowNetwork: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response("<html><style>hidden</style><script>do bad thing</script><h1>Page &amp; text</h1><p>Chinese 中文</p></html>", { headers: { "Content-Type": "text/html" } });
  } });
  const prepared = await agent.prepare("fetch_url", { url: "https://public.test/page" });
  assert.equal(prepared.requiresApproval, false); assert.equal(requests.length, 0);
  const result = await prepared.execute();
  assert.match(result.content, /Page & text/); assert.match(result.content, /中文/); assert.doesNotMatch(result.content, /hidden|do bad/);
  assert.equal(requests[0].options.method, "GET"); assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[0].options.credentials, "omit"); assert.equal(requests[0].options.headers.Authorization, undefined);
});

test("fetch rejects non-text and oversized declared or streamed bodies", async (t) => {
  const scenarios = [
    () => new Response("binary", { headers: { "Content-Type": "application/octet-stream" } }),
    () => new Response("tiny", { headers: { "Content-Type": "text/plain", "Content-Length": "2000000" } }),
    () => new Response("a".repeat(1024 * 1024 + 1), { headers: { "Content-Type": "text/plain" } }),
  ];
  for (const response of scenarios) {
    const { agent } = await fixture(t, { allowNetwork: true, fetchImpl: async () => response() });
    await assert.rejects(perform(agent, "fetch_url", { url: "https://public.test" }), /文本|上限/);
  }
});

test("downloads wait for approval, save binary bytes and never execute or overwrite existing files", async (t) => {
  let calls = 0; const bytes = Buffer.from([0, 255, 2, 3]);
  const { root, agent } = await fixture(t, { allowNetwork: true, fetchImpl: async () => { calls += 1; return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }); } });
  const prepared = await agent.prepare("download_file", { url: "https://public.test/file", path: "download.bin" });
  assert.equal(prepared.requiresApproval, true); assert.equal(prepared.preview.executesFile, false); assert.equal(calls, 0);
  assert.equal((await prepared.execute()).bytes, 4);
  assert.deepEqual(await readFile(path.join(root, "download.bin")), bytes);
  await assert.rejects(agent.prepare("download_file", { url: "https://public.test/file", path: "download.bin" }), /禁止覆盖/);
  const race = await agent.prepare("download_file", { url: "https://public.test/file", path: "race.bin" });
  await writeFile(path.join(root, "race.bin"), "user bytes");
  await assert.rejects(race.execute());
  assert.equal(await readFile(path.join(root, "race.bin"), "utf8"), "user bytes");
  assert.equal((await readdir(root)).some((name) => name.startsWith(".branch-agent-")), false);
});

test("downloads reject oversized content before writing and exclude credential destinations", async (t) => {
  const { root, agent } = await fixture(t, { allowNetwork: true, fetchImpl: async () => new Response("tiny", { headers: { "Content-Length": String(20 * 1024 * 1024 + 1) } }) });
  await assert.rejects(perform(agent, "download_file", { url: "https://public.test", path: "file.bin" }), /20 MiB/);
  await assert.rejects(agent.prepare("download_file", { url: "https://public.test", path: ".env" }), /默认排除/);
  assert.deepEqual(await readdir(root), []);
});

test("SearXNG search uses JSON endpoint, escapes query and limits returned search material", async (t) => {
  let requested;
  const { agent } = await fixture(t, { allowNetwork: true, searchEndpoint: "https://search.test/search?language=zh", fetchImpl: async (url) => {
    requested = new URL(url);
    return Response.json({ results: Array.from({ length: 20 }, (_, i) => ({ title: `Title ${i}`, url: `https://result.test/${i}`, content: "<p>Evidence</p><script>bad</script>" })) });
  } });
  const prepared = await agent.prepare("web_search", { query: "a & 中文" });
  assert.equal(prepared.requiresApproval, false);
  const result = await prepared.execute();
  assert.equal(requested.searchParams.get("q"), "a & 中文"); assert.equal(requested.searchParams.get("format"), "json"); assert.equal(requested.searchParams.get("language"), "zh");
  assert.equal(result.results.length, 10); assert.equal(result.results[0].content, "Evidence");
});
