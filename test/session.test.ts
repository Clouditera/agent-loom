import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TaskFailed, type AgentRole } from "../src/index.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/testing.ts";
import { closeAll, mkRun, msgs, replies, suiteRoot, systemText } from "./helpers.ts";

after(() => rmSync(suiteRoot(), { recursive: true, force: true }));

const A: AgentRole = { name: "a", system: "SYS-A" };
const B: AgentRole = { name: "b", system: "SYS-B" };

/** 上游会话：TASK1（含一次工具调用）+ TASK2 */
async function upstream(name: string) {
  const env = await mkRun(name);
  const p = env.run.pool("p", { needs: "m", concurrency: 1 });
  const s = await env.run.session("up", A);
  env.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("artifact", { action: "create", kind: "note", fields: { text: "t1" } })], { stopReason: "toolUse" }),
    fauxAssistantMessage("T1-DONE"),
  ]);
  const r1 = await p.run(s, "TASK1-PROMPT", { label: "task1" });
  env.faux.setResponses([fauxAssistantMessage("T2-DONE")]);
  const r2 = await p.run(s, "TASK2-PROMPT", { label: "task2" });
  return { ...env, p, s, r1, r2 };
}

test("Task：一次提示词一次完整 turn；周期标记可重建任务视图；产物工具自动带来源", async () => {
  const { run, s, r1, r2 } = await upstream("task");
  assert.equal(r1.output, "T1-DONE");
  assert.equal(r1.attempts, 1);
  assert.equal(r1.artifacts.length, 1);
  const note = r1.artifacts[0]!;
  assert.equal(note.kind, "note");
  assert.equal(note.source.by, "tool");
  assert.equal(note.source.taskId, r1.taskId);
  assert.equal(note.source.sessionId, "up");
  const views = s.tasks();
  assert.deepEqual(views.map((v) => [v.taskId, v.status, v.label]), [[r1.taskId, "done", "task1"], [r2.taskId, "done", "task2"]]);
  await closeAll(run);
});

test("重试：失败后在同一会话发 SDK 继续提示词（新周期、同一任务），用尽抛 TaskFailed", async () => {
  const { run, faux } = await mkRun("retry");
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  const s = await run.session("s", A);
  let seenRetryPrompt = "";
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom-1" }),
    (ctx: any) => {
      seenRetryPrompt = msgs(ctx).at(-1)!;
      return fauxAssistantMessage("RECOVERED");
    },
  ]);
  const r = await p.run(s, "DO-IT", { retry: { max: 3 } });
  assert.equal(r.output, "RECOVERED");
  assert.equal(r.attempts, 2);
  assert.match(seenRetryPrompt, /上一次执行中断.*boom-1/);
  const v = s.task(r.taskId)!;
  assert.equal(v.attempts, 2);
  assert.equal(v.status, "done");

  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "e1" }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "e2" }),
  ]);
  await assert.rejects(p.run(s, "WILL-FAIL", { retry: { max: 2 } }), (e: unknown) => e instanceof TaskFailed && e.attempts === 2 && /e2/.test(e.message));
  assert.equal(s.tasks().at(-1)!.status, "failed");
  await closeAll(run);
});

test("digest：只读——按任务取摘要，上游会话文件一个字节不变；同参数复用不再调模型", async () => {
  const { run, faux, s, r1 } = await upstream("digest");
  const before = readFileSync(s.file, "utf-8");
  let summaryCtx: any;
  faux.setResponses([
    (ctx: any) => {
      summaryCtx = ctx;
      return fauxAssistantMessage("SUMMARY-OF-T1");
    },
  ]);
  const d = await s.digest(r1.taskId, { range: "process+output", prompt: "MY-SPEC" });
  assert.equal(d.text, "SUMMARY-OF-T1");
  assert.equal(readFileSync(s.file, "utf-8"), before, "上游会话文件不变");
  const sys = systemText(summaryCtx);
  assert.match(sys, /MY-SPEC/, "摘要规范进 system 位置");
  const body = msgs(summaryCtx).at(-1)!;
  assert.match(body, /T1-DONE/);
  assert.match(body, /调用工具 artifact/);
  assert.doesNotMatch(body, /TASK1-PROMPT/, "process+output 不含任务提示词");
  assert.doesNotMatch(body, /TASK2/, "只取 TASK1");
  // 复用
  const calls = faux.state.callCount;
  const d2 = await s.digest(r1.taskId, { range: "process+output", prompt: "MY-SPEC" });
  assert.equal(d2.id, d.id);
  assert.equal(faux.state.callCount, calls);
  // 登记成产物
  assert.equal(run.artifacts.query({ kind: "sdk:digest" }).length, 1);
  await closeAll(run);
});

test("digest：摘要不合规范时带着原因重试", async () => {
  const { run, faux, s, r1 } = await upstream("validate");
  let second = "";
  faux.setResponses([
    fauxAssistantMessage("bad"),
    (ctx: any) => {
      second = msgs(ctx).at(-1)!;
      return fauxAssistantMessage("## 结论\ngood");
    },
  ]);
  const d = await s.digest(r1.taskId, { range: "all", validate: (t) => (t.includes("## 结论") ? null : "缺少「## 结论」小节") });
  assert.match(d.text, /good/);
  assert.match(second, /上一次输出不合规范：缺少「## 结论」小节/);
  await closeAll(run);
});

test("fork raw：只要 TASK1 时整段原文带过去（含工具调用与返回），不带 TASK2；子会话换角色", async () => {
  const { run, faux, p, s, r1 } = await upstream("fork-raw");
  const child = await s.fork({ name: "child", agent: B, inherit: { default: "skip", tasks: { [r1.taskId]: "raw" } } });
  let ctx: any;
  faux.setResponses([
    (c: any) => {
      ctx = c;
      return fauxAssistantMessage("CHILD-DONE");
    },
  ]);
  await p.run(child, "CHILD-TASK");
  const m = msgs(ctx);
  assert.ok(m.includes("user:TASK1-PROMPT"));
  assert.ok(m.some((x) => x.startsWith("toolResult:")), "工具返回也带过来了");
  assert.ok(m.includes("assistant:T1-DONE"));
  assert.ok(!m.some((x) => x.includes("TASK2")), "不含 TASK2");
  assert.match(systemText(ctx), /SYS-B/);
  assert.doesNotMatch(systemText(ctx), /SYS-A/, "上游系统提示词没被带过来");
  // 子会话认得继承来的任务
  assert.deepEqual(child.tasks().map((t) => t.origin), ["up", "child"]);
  // 血缘
  const header = JSON.parse(readFileSync(child.file, "utf-8").split("\n")[0]!);
  assert.equal(header.parentSession, s.file);
  // 同名再 fork = 返回已有的（续跑幂等）
  assert.equal(await s.fork({ name: "child" }), child);
  await closeAll(run);
});

test("fork digest：子会话从一条上游摘要开始", async () => {
  const { run, faux, p, s, r1, r2 } = await upstream("fork-digest");
  faux.setResponses([fauxAssistantMessage("SUM-T1")]);
  const child = await s.fork({ name: "c2", inherit: { default: "skip", tasks: { [r1.taskId]: "digest" } } });
  let ctx: any;
  faux.setResponses([(c: any) => ((ctx = c), fauxAssistantMessage("OK"))]);
  await p.run(child, "NEXT");
  const m = msgs(ctx);
  assert.ok(m.some((x) => x.startsWith("user:[上游摘要") && x.includes("SUM-T1")));
  assert.ok(!m.some((x) => x.includes("TASK1-PROMPT")));
  void r2;
  await closeAll(run);
});

test("compress：原位压缩中间的 TASK1，TASK2 原样保留；原文仍在文件里", async () => {
  const { run, faux, p, s, r1 } = await upstream("compress");
  faux.setResponses([fauxAssistantMessage("SUM-T1")]);
  await s.compress(r1.taskId);
  let ctx: any;
  faux.setResponses([(c: any) => ((ctx = c), fauxAssistantMessage("OK"))]);
  await p.run(s, "TASK3");
  const m = msgs(ctx).filter((x) => !x.startsWith("system:"));
  assert.match(m[0]!, /^user:\[已压缩 · 任务 .*SUM-T1/s);
  assert.deepEqual(m.slice(1), ["user:TASK2-PROMPT", "assistant:T2-DONE", "user:TASK3"]);
  assert.match(readFileSync(s.file, "utf-8"), /TASK1-PROMPT/, "原条目还在文件里");
  await closeAll(run);
});

test("文件钩子：agent 用 write 写进登记目录的文件自动登记（路径 + 哈希 + 来源）", async () => {
  const { run, faux, cwd } = await mkRun("hook", { trackFiles: [{ dir: "out", kind: "file", state: "ready" }] });
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  const s = await run.session("w", { name: "writer", system: "W", tools: ["write"] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "out/a.txt", content: "hello" }), fauxToolCall("write", { path: "scratch.txt", content: "tmp" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("WROTE"),
  ]);
  const r = await p.run(s, "write files");
  assert.ok(existsSync(join(cwd, "out/a.txt")));
  const files = run.artifacts.query({ kind: "file" });
  assert.equal(files.length, 1, "只登记 out/ 下的，草稿不登记");
  assert.equal(files[0]!.file!.path, "out/a.txt");
  assert.equal(files[0]!.state, "ready");
  assert.equal(files[0]!.source.by, "hook");
  assert.equal(files[0]!.source.taskId, r.taskId);
  assert.equal(r.artifacts[0]!.id, files[0]!.id);
  await closeAll(run);
});
