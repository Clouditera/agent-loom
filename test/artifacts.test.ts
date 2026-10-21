import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts.ts";
import type { ArtifactSource } from "../src/types.ts";
import { suiteRoot, tmpDir } from "./helpers.ts";

after(() => rmSync(suiteRoot(), { recursive: true, force: true }));

const src: ArtifactSource = { runId: "r1", by: "code" };
const mk = (dir: string, onWrite = () => {}) => new ArtifactStore(dir, () => {}, onWrite);

test("产物：外壳字段齐全，来源与历史自动记录", () => {
  const s = mk(tmpDir("art"));
  const a = s.create("item", { fields: { title: "x" } }, { ...src, taskId: "t1" });
  assert.equal(a.kind, "item");
  assert.equal(a.state, "new");
  assert.equal(a.source.taskId, "t1");
  assert.equal(a.version, 1);
  const b = s.update(a.id, { state: "checked", fields: { note: "ok" } }, { ...src, by: "tool", taskId: "t2" });
  assert.equal(b.state, "checked");
  assert.deepEqual(b.fields, { title: "x", note: "ok" });
  assert.equal(b.history.length, 2);
  assert.equal(b.history[1]!.source.taskId, "t2");
  assert.equal(b.version, 2);
});

test("产物：唯一查询接口按类型 + 状态过滤，按创建先后", () => {
  const s = mk(tmpDir("art"));
  const x = s.create("item", {}, src);
  s.create("other", {}, src);
  const y = s.create("item", { state: "done" }, src);
  const z = s.create("item", {}, src);
  assert.deepEqual(s.query({ kind: "item", state: "new" }).map((a) => a.id), [x.id, z.id]);
  assert.deepEqual(new Set(s.query({ kind: "item", state: ["new", "done"] }).map((a) => a.id)), new Set([x.id, y.id, z.id]));
  assert.deepEqual(s.counts(), { item: { new: 2, done: 1 }, other: { new: 1 } });
});

test("产物：类型约束（状态 / 迁移 / 必填）报错可读", () => {
  const s = mk(tmpDir("art"));
  s.defineKind("ticket", { states: ["open", "fixed", "closed"], initial: "open", transitions: { open: ["fixed"], fixed: ["closed"] }, required: ["title"] });
  assert.throws(() => s.create("ticket", {}, src), /缺少必填字段：title/);
  const t = s.create("ticket", { fields: { title: "a" } }, src);
  assert.equal(t.state, "open");
  assert.throws(() => s.update(t.id, { state: "closed" }, src), /不能从 open 改到 closed；允许：fixed/);
  assert.throws(() => s.update(t.id, { state: "weird" }, src), /不允许状态 weird/);
  s.update(t.id, { state: "fixed" }, src);
});

test("产物：expectState 比较并交换", () => {
  const s = mk(tmpDir("art"));
  const a = s.create("item", {}, src);
  s.update(a.id, { state: "taken" }, src, { expectState: "new" });
  assert.throws(() => s.update(a.id, { state: "taken" }, src, { expectState: "new" }), /不是期望的 new/);
});

test("产物：落盘后重启全部载回；编号含特殊字符也不撞文件", () => {
  const dir = tmpDir("art");
  const s = mk(dir);
  s.create("f", { id: "file:a/b" }, src);
  s.create("f", { id: "file:a_b" }, src);
  s.create("item", { fields: { n: 1 } }, src);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 3);
  const s2 = mk(dir);
  assert.equal(s2.query({ kind: "*" }).length, 3);
  assert.ok(s2.get("file:a/b"));
  assert.ok(s2.get("file:a_b"));
});

test("产物：文件登记按路径去重，内容不变不产生新版本", () => {
  const s = mk(tmpDir("art"));
  let writes = 0;
  const s2 = new ArtifactStore(join(tmpDir("art2")), () => {}, () => { writes++; });
  const a = s2.upsertFile("patch", { path: "out/x.diff", sha256: "h1", bytes: 3 }, src);
  const b = s2.upsertFile("patch", { path: "out/x.diff", sha256: "h1", bytes: 3 }, src);
  assert.equal(a.id, b.id);
  assert.equal(b.version, 1);
  const c = s2.upsertFile("patch", { path: "out/x.diff", sha256: "h2", bytes: 4 }, src);
  assert.equal(c.version, 2);
  assert.equal(writes, 2);
  void s;
});
