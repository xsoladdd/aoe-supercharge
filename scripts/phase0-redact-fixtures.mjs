// Phase 0 fixture redactor (scratch). Allowlist-based: only known enum-like
// fields, timestamps, booleans, numbers and nulls pass through verbatim.
// Every other string is replaced with a deterministic placeholder so that
// cross-references (ids, parent ids, paths) stay consistent across files.
// Usage: node redact.mjs <in.json> <out.json> [<in2.json> <out2.json> ...]
import { readFileSync, writeFileSync } from "node:fs";

const KEEP_KEYS = new Set([
  "status", "tool", "acp_worker_state", "smart_rename", "acp_agent", "profile",
  "state", "reason", "clear_aliases", "managed_by_aoe",
]);
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z?$/;
const HEX16 = /^[0-9a-f]{16}$/;
const maps = new Map(); // category -> Map(original -> placeholder)
function remap(cat, value, make) {
  if (!maps.has(cat)) maps.set(cat, new Map());
  const m = maps.get(cat);
  if (!m.has(value)) m.set(value, make(m.size + 1));
  return m.get(value);
}
const id = (v) => remap("id", v, (n) => n.toString(16).padStart(16, "0").replace(/^0/, "f"));
const repo = (v) => remap("repo", v, (n) => `repo-${String.fromCharCode(96 + n)}`);
function path(v) {
  // keep shape: /Users/dev/<repo>[-worktrees/<branch>] ; never leak real names
  const parts = v.split("/").filter(Boolean);
  const wtIdx = parts.findIndex((p) => p.endsWith("-worktrees"));
  if (wtIdx >= 0) {
    const r = repo(parts[wtIdx].replace(/-worktrees$/, ""));
    return `/Users/dev/code/${r}-worktrees/${branch(parts.slice(wtIdx + 1).join("/"))}`;
  }
  return `/Users/dev/code/${repo(parts.at(-1) ?? "root")}`;
}
const branch = (v) =>
  ["main", "master", "develop"].includes(v) ? v : remap("branch", v, (n) => `feature/task-${n}`);

function redactString(key, v) {
  if (v === "") return v;
  if (HEX16.test(v)) return id(v);
  if (ISO.test(v)) return v;
  if (KEEP_KEYS.has(key)) return v;
  if (/(^|_)(path|dir)$/.test(key) || key === "path") return path(v);
  if (key === "branch" || key === "base_branch") return branch(v);
  if (key === "title") return remap("title", v, (n) => `session-${n}`);
  if (key === "group_path" || key === "group") return remap("group", v, (n) => `group-${n}`);
  return remap("other", v, (n) => `<redacted-${n}>`);
}
function walk(node, key = "") {
  if (Array.isArray(node)) return node.map((x) => walk(x, key));
  if (node && typeof node === "object")
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
  if (typeof node === "string") return redactString(key, node);
  return node;
}
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const out = walk(JSON.parse(readFileSync(args[i], "utf8")));
  writeFileSync(args[i + 1], JSON.stringify(out, null, 2) + "\n");
  console.log(`redacted ${args[i]} -> ${args[i + 1]}`);
}
