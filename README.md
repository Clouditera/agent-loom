# agent-loom

A lightweight agent workflow SDK based on the pi SDK — session context reuse, parallel pools, resumable runs.

通用 agent 工作流 SDK，建在 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（≥ 1.2，已在 1.3.0 上验证）之上。编程式积木：**先后用 `await`，并列用 `run.parallel`**，池与池之间不连线，靠产物的「类型 + 状态」接力。

## 快速开始

```bash
npm install                      # 或：bash scripts/link-pi.sh（把全局安装的 pi 链进 node_modules）
npm test                         # 35 个测试，假模型，约 6 秒
node examples/01-context.ts      # 上下文：摘要 / 原文继承 / 摘要继承 / 换角色
node examples/02-relay.ts        # 并行：生产者 + 两个消费池接力；再跑一次看续跑
```

接真模型：`MODEL=provider/model node examples/02-relay.ts`。凭证读 `~/.pi/agent`（和 pi 命令行同源），也可以自己传 `modelRuntime`。

要求 Node ≥ 22.18（直接跑 `.ts`，不需要编译）。

## 概念和 API 怎么对应

| 概念 | API | 一句话 |
|---|---|---|
| Run | `createRun({ workdir, cwd })` | 一次运行；同一 `workdir` 再启动就是续跑 |
| 资源 / 容量 | `run.capacity(name, { model?, concurrency })` | 真闸门。带 `model` 是模型容量，不带是普通资源（比如沙箱机位） |
| 池 | `run.pool(name, { needs, concurrency, priority, reads, writes })` | 只限流，并声明输入 / 输出。真实并发 = min(池, 容量)；`priority` 越小越下游、越优先 |
| Agent 角色 | `{ name, system, tools?, customTools?, thinking? }` | 系统提示词 + 工具面 |
| Session | `run.session(name, role)` | 一个 pi 会话文件；按名字复活 |
| Task | `pool.run(session, prompt, opts)` | 一次提示词跑一个完整 turn，全程只持有一份许可 |
| 消费者 | `pool.consume({ handle })` | 按池的 `reads` 从持久状态取活，不看上游；全局静默时返回 |
| 产物 | `run.artifacts.*`，agent 用 `artifact` 工具 | 驱动下游的东西必须登记；外壳统一，来源自动带 |

## 骨架

```ts
import { createRun } from "agent-loom";

const run = await createRun({ workdir: ".flow/run-1", cwd: repo });
run.capacity("llm", { model: "anthropic/claude-sonnet-4-5", concurrency: 3 });
const find  = run.pool("find",  { needs: "llm", concurrency: 1, priority: 50,
                                  writes: { kind: "item", state: "new" } });
const check = run.pool("check", { needs: "llm", concurrency: 2, priority: 10,
                                  reads:  { kind: "item", state: "new" },
                                  writes: { kind: "item", state: ["checked", "rejected"] } });
run.graph();   // → find →(item:new)→ check，外加每段积压

// 串行段：普通 await，用 step 记账（续跑时跳过）
const brief = await run.step("init", async () => {
  const s = await run.session("init", role);
  return (await find.run(s, "读项目，写出范围")).output;
});

// 并列段：两段代码同时跑，互不点名
await run.parallel([
  async () => { /* 生产者：跑任务，产出用 artifact 工具或 run.artifacts.create 登记 */ },
  () => check.consume({
    handle: async (item) => {                    // reads 取自池声明
      const s = await run.session(`check-${item.id}`, role);
      await check.run(s, `复核 ${item.id}`);     // agent 用 artifact 工具把它改成 checked / rejected
    },
  }),
]);
await run.close();
```

## ① 上下文

```ts
const t1 = await pool.run(s, "TASK1 …");
const t2 = await pool.run(s, "TASK2 …");

s.tasks();                                   // [{ taskId, status, attempts, label, origin, … }]

// 旁路摘要：只读，按任务取那一段；上游会话一个字节不改，也不要求叶子退回去
const d = await s.digest(t1.taskId, {
  range: "process+output",                   // "process" | "process+output" | "all"
  prompt: "你的摘要规范…",                     // 放在 system 位置
  validate: (t) => t.includes("## 结论") ? null : "缺少结论小节",   // 不合规就带着原因重试
});

// 原位压缩：用 pi 1.3 的 context_edit 把任意任务段替换成摘要（只追加，原文仍在文件里）
await s.compress(t1.taskId);

// 分叉：按任务选 原文 / 摘要 / 不带；可以换角色
const child = await s.fork({
  name: "review-1",
  agent: reviewerRole,
  inherit: { default: "skip", tasks: { [t1.taskId]: "raw" } },   // 只要 TASK1 的原文
});
```

- 原文继承会把整段任务逐条复制，包括工具调用、工具返回和周期标记。上游的 system 消息不复制，子会话第一次请求时写入自己的系统提示词。
- 同名再调用 `fork` 会直接返回已有的子会话，所以续跑时是幂等的。
- 同一个会话同一时刻只跑一个 Task，第二个会排队，排队时不占资源。要并发就 `fork`。
- 摘要也要过容量门（默认用第一个模型容量，或者 `createRun({ summaryCapacity })`），并且会登记成 `sdk:digest` 产物。会话、任务、程度、提示词都相同的旧摘要会直接复用。

## ② 并行调度

- 任务的拿取顺序是：会话锁 → 池名额 → 按名字顺序一次拿全容量许可 → 跑 → 在 finally 里全部归还。没有嵌套加需，所以不会死锁。
- 门的规则：等待超过老化阈值的排最前；然后按优先级，数字小的先；同一优先级先来先得。
- 一个池最多需要一个模型容量，Task 用的模型就是它。其它 `needs` 是普通资源，比如 `{ llm: 1, sandbox: 1 }`。
- `consume` 保证同一条产物同一时刻只被一个消费循环处理。如果 `handle` 跑完了却没推进状态，这条在本 run 内不再取，并列进 `report.stalled`，避免空转。
- **池的输入 / 输出**：`reads` 是取活的选择器，`writes` 是本池会写出的「类型（+ 状态）」。声明之后 SDK 会做三件事：
  - `run.graph()` 和 `state.json` 显示链路与积压，读了却没人写会给出提示。
  - 本池任务写出未声明的东西会被拦下，工具、钩子、代码三个入口都拦。
  - 任务提示词末尾自动附「本步骤需登记的产出」，用 `outputHint: false` 可以关掉。

## ③ 可靠运行

- **重试做薄**：模型出错时，在同一会话里发一条 SDK 生成的继续提示词。这算新周期，但仍是同一个任务。默认最多 3 次，用尽抛 `TaskFailed`。pi 自身的瞬时错误重试仍然保留。
- **失败默认打断**：`consume` 里出错时，run 进入停止状态，不再派新活，在跑的任务跑完，然后 `run.parallel` 抛出错误。状态都已落盘，可以续跑。要跳过出错的那条，用 `onError: "skip"`。
- **收工 = 全局静默**：同时满足四个条件——没有在跑的任务、没有在处理的条目、没有非消费作业（比如还在循环的生产者）、并且安静了 `quietMs`。
- **循环零件**：`run.loop(name, { max, until }, body)`，就是目标 + 判定 + 上限。每轮自动记账，续跑时从下一轮接着跑。
- **续跑**：用同一个 `workdir` 再 `createRun`。
  - 已完成的 `run.step` 直接返回上次记下的结果。
  - `run.session(name)` 会接上原来的会话文件。
  - 消费池按状态把剩下的活做完。
  - 崩溃时没收尾的周期会自动补一个 `aborted`。
- **观测**：`run.stats()` 和落盘版 `workdir/state.json`，内容包括容量、池、在跑与最近的任务、产物计数、会话、串行步、最近事件。也可以用 `run.on(e => …)` 订阅事件。

## 产物

- **外壳**：`id / kind / state / fields / file? / source / history / createdAt / updatedAt / version`。
- **来源自动带**：
  - agent 用工具写的，`by: "tool"`，带 `taskId / sessionId / attempt / pool / item`。
  - 文件钩子登记的，`by: "hook"`。
  - 代码里写的，`by: "code"`；如果是在消费循环里写的，还会带上 `pool / item`。
- **两个写入口**：
  - agent 的 `artifact` 工具，动作有 create / update / get / query。用 `role.artifactTool: { kinds }` 限定允许操作的类型。
  - 文件钩子：`createRun({ trackFiles: [{ dir: "out", kind: "patch" }] })`。agent 用 write / edit 写进 `out/` 的文件会自动登记成路径 + sha256 + 来源。
- **一个查询接口**：`run.artifacts.query({ kind, state, where })`。选活、观测、续跑判断都用它。
- **类型约束是可选的**：`run.artifacts.defineKind(kind, { states, transitions, required })`。SDK 只做校验，不解释状态的含义，报错信息是写给 agent 看的。

## 目录

```
src/
  run.ts        Run / Pool：编排、消费循环、收工、续跑、观测
  session.ts    Session：周期、digest、compress、fork、产物工具、文件钩子
  sched.ts      Capacity（真闸门 + 门）/ PoolGate（限流）
  artifacts.ts  产物登记处（每条一个 JSON，原子写）
  serialize.ts  按摘要程度序列化任务段；默认摘要提示词
  types.ts      公共类型与错误
  testing.ts    假模型 runtime（不需要凭证）
test/           sched / artifacts / session / run / contract 五组，35 个用例
examples/       01-context、02-relay
```

运行目录 `workdir/` 里有：`artifacts/*.json`、`sessions/*.jsonl`（pi 原生会话文件，可以直接用 pi 打开）、`sessions.json`、`ledger.jsonl`（台账：run / task / step / item-failed）、`state.json`。

## 当前边界（已知、有意为之）

- **单进程**：产物存储和会话锁都在进程内，不支持多个进程同时跑同一个 `workdir`。
- **文件钩子只看 write / edit**：用 bash 写出来的文件不会自动登记，需要用产物工具或代码登记。
- **摘要的定位**：摘要过容量门（占模型名额），但不进池、不算 Task。
- **一个池最多一个模型容量**：Task 用的模型就是它。
- **压缩和分叉以「任务」为单位**：不在任何任务里的手工条目不参与。
- **没做**：速率 / 预算型资源、汇合原语、会话间通信、人工确认。
- **只用 pi 公开 API**：`createAgentSession`、`SessionManager.open`、`appendCustomEntry`、`appendContextEdit`、`getBranch`、`ModelRuntime.completeSimple`。分叉是自己写 jsonl，不依赖任何私有成员。
