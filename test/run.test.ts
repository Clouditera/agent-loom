import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRun, RunStopped, TaskFailed, type AgentRole } from "../src/index.ts";
import { fauxAssistantMessage, fauxRuntime } from "../src/testing.ts";
import { closeAll, mkRun, replies, suiteRoot, tmpDir } from "./helpers.ts";

after(() => rmSync(suiteRoot(), { recursive: true, force: true }));

const R: AgentRole = { name: "worker", system: "W" };

test("状态接力：三个池同时跑、互不连线，靠 类型+状态 接力；全局静默时自己收工", async () => {
  const { run, faux } = await mkRun("relay");
  faux.setResponses(replies(200, "ok", 5));
  const make = run.pool("make", { needs: "m", concurrency: 1, priority: 50 });
  const check = run.pool("check", { needs: "m", concurrency: 2, priority: 30 });
  const finish = run.pool("finish", { needs: "m", concurrency: 2, priority: 10 });
  const order: string[] = [];

  const [, rc, rf] = await run.parallel([
    // 循环型生产者：分 3 轮，每轮登记 2 条（轮次之间消费者不会误判收工）
    async () => {
      const s = await run.session("maker", R);
      for (let round = 1; round <= 3; round++) {
        await make.run(s, `round ${round}`);
        for (let k = 0; k < 2; k++) run.artifacts.create("item", { fields: { round, k } });
        await new Promise((r) => setTimeout(r, 200)); // 比安静窗口长：考验收工判断
      }
    },
    () =>
      check.consume({
        reads: { kind: "item", state: "new" },
        handle: async (item) => {
          const s = await run.session(`check-${item.id}`, R);
          await check.run(s, `check ${item.id}`);
          run.artifacts.update(item.id, { state: "checked" });
          order.push(`check:${item.id}`);
        },
      }),
    () =>
      finish.consume({
        reads: { kind: "item", state: "checked" },
        handle: async (item) => {
          const s = await run.session(`fin-${item.id}`, R);
          await finish.run(s, `finish ${item.id}`);
          run.artifacts.update(item.id, { state: "done" });
          order.push(`finish:${item.id}`);
        },
      }),
  ] as const);

  assert.deepEqual(run.artifacts.counts().item, { done: 6 });
  assert.equal(rc.handled, 6);
  assert.equal(rf.handled, 6);
  // 上下游交错：第一条 finish 出现在最后一条 check 之前（不是流水线式先全部 check 再 finish）
  const firstFinish = order.findIndex((x) => x.startsWith("finish:"));
  const lastCheck = order.map((x) => x.startsWith("check:")).lastIndexOf(true);
  assert.ok(firstFinish < lastCheck, `上下游应交错运行：${order.join(" ")}`);
  // 代码写产物时来源自动带上 池 + 条目
  const one = run.artifacts.query({ kind: "item" })[0]!;
  assert.ok(one.history.some((h) => h.source.pool === "finish" && h.source.item === one.id));
  await closeAll(run);
});

test("真实并发 = min(池上限, 容量)", async () => {
  const { run, faux } = await mkRun("min");
  run.capacity("m", { model: "faux/m1", concurrency: 2 });
  const p = run.pool("p", { needs: "m", concurrency: 5 });
  let cur = 0;
  let peak = 0;
  faux.setResponses(
    Array.from({ length: 6 }, () => async () => {
      cur++;
      peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 40));
      cur--;
      return fauxAssistantMessage("ok");
    }),
  );
  await Promise.all(Array.from({ length: 6 }, async (_, i) => p.run(await run.session(`s${i}`, R), "go")));
  assert.equal(peak, 2);
  await closeAll(run);
});

test("资源紧张时下游优先：同一容量上，优先级小的池先拿到", async () => {
  const { run, faux } = await mkRun("prio");
  run.capacity("m", { model: "faux/m1", concurrency: 1 });
  const up = run.pool("up", { needs: "m", concurrency: 3, priority: 50 });
  const down = run.pool("down", { needs: "m", concurrency: 3, priority: 10 });
  const order: string[] = [];
  faux.setResponses(
    Array.from({ length: 5 }, () => async (ctx: any) => {
      const last = ctx.messages.at(-1);
      order.push(typeof last.content === "string" ? last.content : last.content[0].text);
      await new Promise((r) => setTimeout(r, 20));
      return fauxAssistantMessage("ok");
    }),
  );
  const s = await Promise.all([0, 1, 2, 3, 4].map((i) => run.session(`p${i}`, R)));
  const first = up.run(s[0]!, "up-0");
  await new Promise((r) => setTimeout(r, 5));
  await Promise.all([first, up.run(s[1]!, "up-1"), up.run(s[2]!, "up-2"), down.run(s[3]!, "down-3"), down.run(s[4]!, "down-4")]);
  assert.deepEqual(order, ["up-0", "down-3", "down-4", "up-1", "up-2"]);
  await closeAll(run);
});

test("同一会话同一时刻只跑一个 Task（第二个排队，不占资源）", async () => {
  const { run, faux } = await mkRun("lock");
  const p = run.pool("p", { needs: "m", concurrency: 2 });
  const s = await run.session("one", R);
  let cur = 0;
  let peak = 0;
  faux.setResponses(
    Array.from({ length: 2 }, () => async () => {
      cur++;
      peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 30));
      cur--;
      return fauxAssistantMessage("ok");
    }),
  );
  await Promise.all([p.run(s, "a"), p.run(s, "b")]);
  assert.equal(peak, 1);
  assert.equal(s.tasks().length, 2);
  await closeAll(run);
});

test("handle 没推进状态：本 run 内不再取（不空转），并在报告里列出", async () => {
  const { run } = await mkRun("stall");
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  const a = run.artifacts.create("item");
  let calls = 0;
  const rep = await p.consume({ reads: { kind: "item", state: "new" }, handle: async () => { calls++; } });
  assert.equal(calls, 1);
  assert.deepEqual(rep.stalled, [a.id]);
  await closeAll(run);
});

test("消费失败默认打断：run 停止派活、parallel 抛出、台账留痕；之后新任务被拒绝", async () => {
  const { run, faux } = await mkRun("stop");
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "down" }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "down" }),
  ]);
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  run.artifacts.create("item");
  run.artifacts.create("item");
  await assert.rejects(
    run.parallel([
      () =>
        p.consume({
          reads: { kind: "item", state: "new" },
          handle: async (item) => {
            await p.run(await run.session(`x-${item.id}`, R), "go", { retry: { max: 2 } });
            run.artifacts.update(item.id, { state: "done" });
          },
        }),
    ]),
    TaskFailed,
  );
  assert.equal(run.stopping, true);
  assert.equal(run.artifacts.counts().item!.new, 2, "第二条没被派出去");
  const ledger = readFileSync(join(run.workdir, "ledger.jsonl"), "utf-8");
  assert.match(ledger, /"t":"item-failed"/);
  await assert.rejects(p.run(await run.session("late", R), "x"), RunStopped);
  await closeAll(run);
});

test("续跑：同一 workdir 再启动——已完成的 step 跳过、会话接上原上下文、按状态把剩下的活做完", async () => {
  const dir = tmpDir("resume");
  const cwd = join(dir, "cwd");
  const workdir = join(dir, "run");

  // 第一次：init 做完，处理到一半"崩溃"
  {
    const { runtime, faux } = await fauxRuntime({ dir });
    const run = await createRun({ workdir, cwd, modelRuntime: runtime, quietMs: 100, pollMs: 30 });
    run.capacity("m", { model: "faux/m1", concurrency: 1 });
    const p = run.pool("p", { needs: "m", concurrency: 1 });
    faux.setResponses(replies(10, "INIT-DONE"));
    const n = await run.step("init", async () => {
      const s = await run.session("main", R);
      await p.run(s, "INIT");
      for (let i = 0; i < 3; i++) run.artifacts.create("item", { fields: { i } });
      return 3;
    });
    assert.equal(n, 3);
    const first = run.artifacts.query({ kind: "item" })[0]!;
    run.artifacts.update(first.id, { state: "done" });
    // 模拟崩溃时会话里留下一个没收尾的周期
    (await run.session("main", R)).appendCycle({ phase: "start", taskId: "t-crashed", attempt: 1, session: "main", prompt: "half" });
    await run.close();
  }

  // 第二次：同一 workdir
  const { runtime, faux } = await fauxRuntime({ dir });
  const run = await createRun({ workdir, cwd, modelRuntime: runtime, quietMs: 100, pollMs: 30 });
  run.capacity("m", { model: "faux/m1", concurrency: 1 });
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  let initRan = false;
  const n = await run.step("init", async () => {
    initRan = true;
    return 0;
  });
  assert.equal(initRan, false, "init 不重做");
  assert.equal(n, 3, "返回上次记下的结果");
  const main = await run.session("main", R);
  const views = main.tasks();
  assert.equal(views[0]!.status, "done");
  assert.equal(views.find((v) => v.taskId === "t-crashed")!.status, "aborted", "崩溃时没收尾的周期被补上 aborted");
  // 会话接上原上下文：模型能看到上次的 INIT
  let sawInit = false;
  faux.setResponses(
    replies(10, (ctx: any) => {
      sawInit ||= JSON.stringify(ctx.messages).includes("INIT-DONE");
      return "ok";
    }),
  );
  await p.run(main, "CONTINUE");
  assert.ok(sawInit);
  // 按状态把剩下的 2 条做完
  const rep = await p.consume({
    reads: { kind: "item", state: "new" },
    handle: async (item) => {
      run.artifacts.update(item.id, { state: "done" });
    },
  });
  assert.equal(rep.handled, 2);
  assert.deepEqual(run.artifacts.counts().item, { done: 3 });
  await run.close();
  const state = JSON.parse(readFileSync(join(workdir, "state.json"), "utf-8"));
  assert.equal(state.status, "closed");
  assert.ok(state.capacities.length === 1 && state.pools.length === 1);
  assert.ok(existsSync(join(workdir, "sessions.json")));
});

test("循环零件 run.loop：目标 + 判定 + 上限；续跑时从下一轮接着跑", async () => {
  const dir = tmpDir("loop");
  const workdir = join(dir, "run");
  const cwd = join(dir, "cwd");
  const bodyCalls: number[] = [];
  {
    const { runtime } = await fauxRuntime({ dir });
    const run = await createRun({ workdir, cwd, modelRuntime: runtime });
    // 第 2 轮"崩溃"
    await assert.rejects(
      run.loop("refine", { max: 5, until: (score: number) => score >= 3 }, async (round) => {
        bodyCalls.push(round);
        if (round === 2) throw new Error("crash");
        return round;
      }),
      /crash/,
    );
    await run.close();
  }
  const { runtime } = await fauxRuntime({ dir });
  const run = await createRun({ workdir, cwd, modelRuntime: runtime });
  const r = await run.loop("refine", { max: 5, until: (score: number) => score >= 3 }, async (round) => {
    bodyCalls.push(round);
    return round;
  });
  assert.deepEqual(bodyCalls, [1, 2, 2, 3], "第 1 轮不重做，从第 2 轮接着跑");
  assert.deepEqual(r, { rounds: 3, results: [1, 2, 3], stopped: "until" });
  const capped = await run.loop("cap", { max: 2 }, async (round) => round);
  assert.equal(capped.stopped, "max");
  await run.close();
});
