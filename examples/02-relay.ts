/**
 * 示例 02：并行调度 + 可靠运行 —— 一个循环型生产者 + 两个状态驱动的消费池，同时跑、互不连线；
 * 全局静默时自动收工。再跑一次 = 续跑（已完成的 step 跳过，已办结的产物不重做）。
 *
 *   node examples/02-relay.ts            # 第一次
 *   node examples/02-relay.ts            # 再跑一次：看到续跑
 *   node examples/02-relay.ts --fresh    # 清掉重来
 *   MODEL=provider/model node examples/02-relay.ts   # 真模型
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRun, type AgentRole } from "../src/index.ts";
import { fauxAssistantMessage, fauxRuntime } from "../src/testing.ts";

const workdir = join(import.meta.dirname, ".runs", "02-relay");
if (process.argv.includes("--fresh")) rmSync(workdir, { recursive: true, force: true });

const real = process.env.MODEL;
let runtime;
if (!real) {
  const f = await fauxRuntime({ dir: workdir });
  runtime = f.runtime;
  f.faux.setResponses(
    Array.from({ length: 500 }, () => async () => {
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      return fauxAssistantMessage("（假模型）完成");
    }),
  );
}

const run = await createRun({ workdir, modelRuntime: runtime, quietMs: 800, pollMs: 200 });
run.on((e) => {
  if (e.type === "task:end") console.log(`  task ${e.pool.padEnd(7)} ${e.status} ${e.ms}ms`);
  if (e.type === "step") console.log(`step ${e.name}: ${e.status}`);
});

// 资源：一个模型，最多 3 路并发（真闸门）
run.capacity("llm", { model: real ?? "faux/m1", concurrency: 3 });
// 池：只限流；priority 越小越下游越优先
const produce = run.pool("produce", { needs: "llm", concurrency: 1, priority: 50 });
const check = run.pool("check", { needs: "llm", concurrency: 2, priority: 30 });
const finish = run.pool("finish", { needs: "llm", concurrency: 2, priority: 10 });

// 可选：给类型加约束（SDK 只校验，不解释含义）
run.artifacts.defineKind("item", { states: ["new", "checked", "done"], transitions: { new: ["checked"], checked: ["done"] } });

const worker: AgentRole = { name: "worker", system: "你是一个执行助手，用一句话回答。" };

// 串行段：普通 await；用 step 记账，续跑时跳过
const brief = await run.step("prepare", async () => {
  const s = await run.session("prepare", worker);
  const r = await produce.run(s, "用一句话说明今天的工作目标。");
  return r.output;
});
console.log("目标:", brief);

// 并列段：生产者 + 两个消费池同时跑
await run.parallel([
  async () => {
    for (let round = 1; round <= 3; round++) {
      await run.step(`produce-round-${round}`, async () => {
        const s = await run.session(`producer-r${round}`, worker);
        await produce.run(s, `第 ${round} 轮：提出两个待办。`);
        for (let k = 1; k <= 2; k++) run.artifacts.create("item", { fields: { round, k } });
      });
    }
  },
  () =>
    check.consume({
      reads: { kind: "item", state: "new" },
      handle: async (item) => {
        const s = await run.session(`check-${item.id}`, worker);
        await check.run(s, `检查待办 ${JSON.stringify(item.fields)} 是否合理。`);
        run.artifacts.update(item.id, { state: "checked" });
      },
    }),
  () =>
    finish.consume({
      reads: { kind: "item", state: "checked" },
      handle: async (item) => {
        const s = await run.session(`finish-${item.id}`, worker);
        await finish.run(s, `完成待办 ${JSON.stringify(item.fields)}。`);
        run.artifacts.update(item.id, { state: "done" });
      },
    }),
]);

const st = run.stats();
console.log("\n产物:", JSON.stringify(st.artifacts));
console.log("池:", st.pools.map((p) => `${p.name} 完成${p.completed}`).join(" / "));
console.log("观测文件:", join(workdir, "state.json"));
await run.close();
