import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "../src/index.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/testing.ts";
import { closeAll, mkRun, msgs, replies, suiteRoot } from "./helpers.ts";

after(() => rmSync(suiteRoot(), { recursive: true, force: true }));

const R: AgentRole = { name: "worker", system: "W" };

/** 三段链路：find →(item:new)→ check →(item:checked)→ finish */
async function chain(name: string) {
  const env = await mkRun(name);
  const { run } = env;
  const find = run.pool("find", { needs: "m", concurrency: 1, writes: { kind: "item", state: "new" } });
  const check = run.pool("check", {
    needs: "m",
    concurrency: 2,
    reads: { kind: "item", state: "new" },
    writes: { kind: "item", state: ["checked", "rejected"] },
  });
  const finish = run.pool("finish", { needs: "m", concurrency: 2, reads: { kind: "item", state: "checked" }, writes: { kind: "item", state: "done" } });
  return { ...env, find, check, finish };
}

test("链路：由 reads / writes 对出来，带每段积压；读了没人写 → 提示；写了没人读 → 终态", async () => {
  const { run } = await chain("graph");
  run.pool("orphan", { needs: "m", concurrency: 1, reads: { kind: "ghost", state: "x" } });
  run.artifacts.create("item");
  run.artifacts.create("item");
  const g = run.graph();
  assert.deepEqual(
    g.edges.map((e) => `${e.from}->${e.to} ${e.kind}:${e.state} backlog=${e.backlog}`),
    ["find->check item:new backlog=2", "check->finish item:checked backlog=0"],
  );
  assert.equal(g.warnings.length, 1);
  assert.match(g.warnings[0]!, /orphan 读 ghost:x/);
  assert.deepEqual(g.terminal, ["check → item:rejected", "finish → item:done"]);
  // 观测里也有
  await run.close();
  const state = JSON.parse(readFileSync(join(run.workdir, "state.json"), "utf-8"));
  assert.equal(state.graph.edges.length, 2);
  assert.deepEqual(state.pools.find((p: any) => p.name === "check").writes, [{ kind: "item", state: ["checked", "rejected"] }]);
});

test("consume 默认用池上声明的 reads；三段接力跑完", async () => {
  const { run, faux, find, check, finish } = await chain("relay");
  faux.setResponses(replies(50));
  await run.parallel([
    async () => {
      const s = await run.session("finder", R);
      await find.run(s, "find");
      // 模拟 agent 产出：这里用代码登记，但处在 find 的任务之外 → 不受池校验
      for (let i = 0; i < 3; i++) run.artifacts.create("item", { fields: { i } });
    },
    () =>
      check.consume({
        handle: async (item) => {
          await check.run(await run.session(`c-${item.id}`, R), "check");
          run.artifacts.update(item.id, { state: item.fields.i === 1 ? "rejected" : "checked" });
        },
      }),
    () =>
      finish.consume({
        handle: async (item) => {
          await finish.run(await run.session(`f-${item.id}`, R), "finish");
          run.artifacts.update(item.id, { state: "done" });
        },
      }),
  ]);
  assert.deepEqual(run.artifacts.counts().item, { done: 2, rejected: 1 });
  await closeAll(run);
});

test("写入校验（代码入口）：消费循环里只能写本池声明过的 类型+状态；只改字段允许", async () => {
  const { run, check } = await chain("guard-code");
  run.artifacts.create("item");
  const seen: string[] = [];
  await check.consume({
    handle: async (item) => {
      assert.throws(() => run.artifacts.update(item.id, { state: "done" }), /池 check 没有声明会写 item:done。本池声明的产出：item（状态 checked \/ rejected）/);
      assert.throws(() => run.artifacts.create("report"), /池 check 没有声明会写 report:new/);
      run.artifacts.update(item.id, { fields: { note: "只改字段" } });
      run.artifacts.update(item.id, { state: "checked" });
      seen.push(item.id);
    },
  });
  assert.equal(seen.length, 1);
  const a = run.artifacts.query({ kind: "item" })[0]!;
  assert.equal(a.state, "checked");
  assert.equal(a.fields.note, "只改字段");
  // 池外的代码不受限制
  run.artifacts.create("report");
  await closeAll(run);
});

test("写入校验（工具入口）：agent 写未声明的状态拿到可读的错误；写声明过的放行", async () => {
  const { run, faux, check } = await chain("guard-tool");
  const item = run.artifacts.create("item");
  let toolResults: string[] = [];
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("artifact", { action: "update", id: item.id, state: "done" }),
        fauxToolCall("artifact", { action: "update", id: item.id, state: "checked", fields: { verdict: "ok" } }),
      ],
      { stopReason: "toolUse" },
    ),
    (ctx: any) => {
      toolResults = msgs(ctx).filter((m) => m.startsWith("toolResult:"));
      return fauxAssistantMessage("done");
    },
  ]);
  const r = await check.run(await run.session("checker", R), `check ${item.id}`);
  assert.match(toolResults[0]!, /错误：池 check 没有声明会写 item:done/);
  assert.match(toolResults[1]!, /"state": "checked"/);
  assert.equal(run.artifacts.get(item.id)!.state, "checked");
  assert.equal(run.artifacts.get(item.id)!.source.pool, undefined, "来源是创建时的（代码）");
  assert.equal(run.artifacts.get(item.id)!.history.at(-1)!.source.taskId, r.taskId);
  await closeAll(run);
});

test("产出提示：池声明了 writes 时提示词末尾附「本步骤需登记的产出」，可关；没声明不附", async () => {
  const { run, faux, check } = await chain("hint");
  const free = run.pool("free", { needs: "m", concurrency: 1 });
  const prompts: string[] = [];
  faux.setResponses(replies(3, (ctx: any) => (prompts.push(msgs(ctx).at(-1)!), "ok")));
  await check.run(await run.session("a", R), "DO");
  await check.run(await run.session("b", R), "DO", { outputHint: false });
  await free.run(await run.session("c", R), "DO");
  assert.equal(prompts[0], "user:DO\n\n---\n本步骤需登记的产出（用 artifact 工具）：item（状态 checked / rejected）");
  assert.equal(prompts[1], "user:DO");
  assert.equal(prompts[2], "user:DO");
  await closeAll(run);
});

test("consume：池和调用处都没给 reads 时直接报错", async () => {
  const { run } = await mkRun("noreads");
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  await assert.rejects(p.consume({ handle: async () => {} }), /没有声明 reads/);
  await closeAll(run);
});

test("写入校验（钩子入口）：池没声明的文件产出不登记，留 artifact:rejected 事件，任务照常完成", async () => {
  const { run, faux } = await mkRun("guard-hook", { trackFiles: [{ dir: "out", kind: "patch" }] });
  const p = run.pool("p", { needs: "m", concurrency: 1, writes: { kind: "item" } });
  const rejected: any[] = [];
  run.on((e) => e.type === "artifact:rejected" && rejected.push(e));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "out/a.diff", content: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("ok"),
  ]);
  const r = await p.run(await run.session("w", { name: "w", system: "W", tools: ["write"] }), "write");
  assert.equal(r.output, "ok");
  assert.equal(run.artifacts.query({ kind: "patch" }).length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].path, "out/a.diff");
  assert.match(rejected[0].reason, /池 p 没有声明会写 patch:new/);
  await closeAll(run);
});
