import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBook, UnknownAgentError } from "../src/index.ts";
import type { AgentRole } from "../src/index.ts";

/** 一份最小的角色，只关心被配置改到的那几项。 */
const role = (name: string, extra: Partial<AgentRole> = {}): AgentRole => ({ name, system: `${name} 的提示词`, ...extra });

const specs = [
  { key: "hunt", title: "寻找假设", description: "提出可验证的假设", defaults: { tools: ["read"] } },
  { key: "verify", title: "验证假设" },
];

test("声明了哪些 agent，按名字取得它们的默认配置", () => {
  const book = new AgentBook(specs);
  assert.deepEqual(book.keys(), ["hunt", "verify"]);
  assert.deepEqual(book.resolve("hunt").tools, ["read"]);
  assert.deepEqual(book.resolve("verify").tools, []);
});

test("模型与档位由外部配置覆盖；数组字段（技能、工具）是叠加，不是替换", () => {
  const book = new AgentBook(specs, { hunt: { tools: ["bash"], skills: ["/s1"], model: "p/m1" } });
  const resolved = book.resolve("hunt");
  assert.equal(resolved.model, "p/m1");
  assert.deepEqual(resolved.tools, ["read", "bash"]);
  assert.deepEqual(resolved.skills, ["/s1"]);
});

test("角色的技能与提示词在配置之后，配置自己的在前", () => {
  const book = new AgentBook(specs, { hunt: { skills: ["/from-config"], prompts: ["/p-config"] } });
  const as = book.role("hunt", role("hunt", { skills: ["/from-role"], prompts: ["/p-role"] }));
  assert.deepEqual(as.skills, ["/from-config", "/from-role"]);
  assert.deepEqual(as.prompts, ["/p-config", "/p-role"]);
  assert.equal(as.name, "hunt:hunt");
});

test("思考档位单独给容量，模型串保持原样", () => {
  const book = new AgentBook(specs, { hunt: { model: "p/m1", thinking: "max" } });
  const resolved = book.resolve("hunt");
  assert.equal(resolved.thinking, "max");
  assert.equal(resolved.model, "p/m1");
});

test("调用方自己把档位写在后缀里时，只留一份说法", () => {
  const book = new AgentBook(specs, { hunt: { model: "p/m1:max", thinking: "max" } });
  const resolved = book.resolve("hunt");
  assert.equal(resolved.model, "p/m1");
  assert.equal(resolved.thinking, "max");
});

test("要到没声明的 agent 是错误，不是静默忽略", () => {
  assert.throws(() => new AgentBook(specs, { nope: {} }), UnknownAgentError);
  const book = new AgentBook(specs);
  assert.throws(() => book.resolve("nope"), UnknownAgentError);
});

test("Pool.with 把产物记到台账上；没有这条产物就报错", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createRun } = await import("../src/index.ts");
  const { fauxRuntime } = await import("../src/testing.ts");
  const dir = mkdtempSync(join(tmpdir(), "agent-loom-with-"));
  const { runtime } = await fauxRuntime({ dir });
  const run = await createRun({ workdir: join(dir, "run"), modelRuntime: runtime, quietMs: 50, pollMs: 20 });
  run.capacity("m", { concurrency: 1 });
  const pool = run.pool("p", { needs: "m", concurrency: 1 });
  const item = run.artifacts.create("k");
  let seen: unknown;
  await pool.with(item.id, async () => { seen = item.id; });
  assert.equal(seen, item.id);
  await assert.rejects(() => pool.with("nope", async () => {}), /没有产物/);
  await run.close();
});
