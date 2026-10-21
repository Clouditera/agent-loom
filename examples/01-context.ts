/**
 * 示例 01：上下文 —— 一个会话跑两个任务；只取 TASK1 的摘要；分叉出子会话（换角色）分别用原文 / 摘要继承。
 *
 *   node examples/01-context.ts                 # 假模型，不需要任何凭证
 *   MODEL=anthropic/claude-sonnet-4-5 node examples/01-context.ts   # 真模型（读 ~/.pi/agent 的凭证）
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRun, type AgentRole } from "../src/index.ts";
import { fauxAssistantMessage, fauxRuntime } from "../src/testing.ts";

const workdir = join(import.meta.dirname, ".runs", "01-context");
rmSync(workdir, { recursive: true, force: true });

const real = process.env.MODEL;
let modelRef = real ?? "faux/m1";
let runtime;
if (!real) {
  const f = await fauxRuntime({ dir: workdir });
  runtime = f.runtime;
  // 假模型：按收到的最后一句话随便编一个回复
  f.faux.setResponses(
    Array.from({ length: 20 }, () => (ctx: any) => {
      const last = ctx.messages.at(-1);
      const text = typeof last.content === "string" ? last.content : last.content.map((c: any) => c.text ?? "").join("");
      return fauxAssistantMessage(`（假模型回复）收到：${text.slice(0, 40)}`);
    }),
  );
  modelRef = "faux/m1";
}

const run = await createRun({ workdir, modelRuntime: runtime });
run.capacity("main", { model: modelRef, concurrency: 2 });
const pool = run.pool("work", { needs: "main", concurrency: 2 });

const analyst: AgentRole = { name: "analyst", system: "你是一个简洁的分析助手，回答不超过三句话。" };
const reviewer: AgentRole = { name: "reviewer", system: "你是一个挑剔的审阅者，只指出问题，不超过三句话。" };

// --- 上游：一个会话跑两个任务
const up = await run.session("upstream", analyst);
const t1 = await pool.run(up, "列出设计一个任务队列时最重要的三个考虑点。", { label: "task1" });
const t2 = await pool.run(up, "把这三点按实现难度排序。", { label: "task2" });
console.log("TASK1:", t1.output);
console.log("TASK2:", t2.output);

// --- 只取 TASK1 的摘要（只读，不动上游会话）
const d = await up.digest(t1.taskId, { range: "process+output", prompt: "用一句话概括这个任务的结论。" });
console.log("\nTASK1 摘要:", d.text);

// --- 分叉 A：原文继承 TASK1（不带 TASK2），换成审阅者角色
const childRaw = await up.fork({ name: "review-raw", agent: reviewer, inherit: { default: "skip", tasks: { [t1.taskId]: "raw" } } });
const r1 = await pool.run(childRaw, "审阅上面列出的三点。");
console.log("\n[原文继承] 审阅:", r1.output);

// --- 分叉 B：摘要继承 TASK1（复用上面的摘要，不再调模型）
const childDigest = await up.fork({
  name: "review-digest",
  agent: reviewer,
  inherit: { default: "skip", tasks: { [t1.taskId]: "digest" }, digest: { range: "process+output", prompt: "用一句话概括这个任务的结论。" } },
});
const r2 = await pool.run(childDigest, "审阅上游结论。");
console.log("[摘要继承] 审阅:", r2.output);

console.log("\n上游任务:", up.tasks().map((t) => `${t.label}:${t.status}`).join(", "));
console.log("子会话 A 认得的任务:", childRaw.tasks().map((t) => `${t.origin}/${t.label ?? "-"}`).join(", "));
console.log("运行目录:", workdir);
await run.close();
