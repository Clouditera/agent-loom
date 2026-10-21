# agent-loom 接口与用法

> 标 **★** 的是池的输入 / 输出契约（reads / writes）相关接口。所有接口都有测试（`npm test`，35 个用例，用假模型跑）。

---

## 0. 总览

| 类别 | 接口 | 一句话 |
|---|---|---|
| 运行 | `createRun` / `run.close` / `run.stop` / `run.abort` | 一次运行；同一 workdir 再启动就是续跑 |
| 资源与池 | `run.capacity` / `run.pool` ★reads/writes / `run.graph` ★ | 容量是真闸门，池只限流；池声明读什么、写什么 |
| 角色与会话 | `AgentRole` / `run.session` / `session.tasks` | 会话 = 一个 pi 会话文件 + 一个角色 |
| 任务 | `pool.run` | 一次提示词跑一个完整 turn，全程只持有一份许可，失败时任务内重试 |
| 上下文 | `session.digest` / `session.compress` / `session.fork` | 旁路摘要、原位压缩、分叉继承 |
| 产物 | `run.artifacts.*` / agent 的 `artifact` 工具 / 文件钩子 | 驱动下游的东西必须登记 |
| 编排 | `run.step` / `run.loop` / `run.parallel` / `pool.consume` | 先后用 await，并列用 parallel，接力靠状态；循环有零件 |
| 观测 | `run.stats` / `state.json` / `run.on` / `ledger.jsonl` | 一个接口、一个文件看全局 |
| 测试 | `fauxRuntime` | 假模型，不需要凭证 |

```ts
import { createRun } from "agent-loom";
import { fauxRuntime, fauxAssistantMessage, fauxToolCall } from "agent-loom/testing";
```

---

## 1. 运行（Run）

```ts
createRun(opts: RunOptions): Promise<Run>

interface RunOptions {
  workdir: string;              // 运行目录：产物、会话、台账、state.json 都在这里；同目录再启动 = 续跑
  cwd?: string;                 // agent 工作目录（内置工具的根），默认 process.cwd()
  modelRuntime?: ModelRuntime;  // pi 的模型运行时；默认 ModelRuntime.create()，凭证读 ~/.pi/agent
  summaryCapacity?: string;     // 摘要默认用哪个模型容量；不填用第一个模型容量
  trackFiles?: TrackFiles[];    // 文件钩子，见 §6.3
  piSettings?: object;          // 透传给 pi SettingsManager（默认开启 pi 的瞬时错误重试和上下文压缩）
  quietMs?: number;             // 收工判断的安静窗口，默认 1500
  pollMs?: number;              // 消费循环没活时的轮询间隔，默认 1000（有新写入会立即唤醒）
}

run.id / run.workdir / run.cwd
run.stop(reason)      // 平稳停止：不再派新活，在跑的跑完
run.abort(reason?)    // 立即中止：停止 + 打断在跑的任务
run.stopping          // 是否已进入停止
run.close()           // 释放所有 pi 会话，写最终状态（会话文件保留）
```

---

## 2. 资源与池（并行调度）

```ts
run.capacity(name: string, opts: CapacityOptions): Capacity
interface CapacityOptions {
  model?: ModelRef;     // "provider/model[:thinking]" 或 pi Model；带上 = 模型容量，不带 = 普通资源（沙箱机位等）
  concurrency: number;  // 同时几路：外部能力决定，是真闸门；同名再调用 = 运行期调整
  agingMs?: number;     // 等待超过多久视为最高优先（防饿死），默认 15 分钟
}

run.pool(name: string, opts: PoolOptions): Pool
interface PoolOptions {
  needs?: string | string[] | Record<string, number>;   // 要哪些容量、各几份；一个池最多一个模型容量
  concurrency: number;                                  // 池上限，只限流；真实并发 = min(池, 容量)
  priority?: number;                                    // 越小越下游、越优先，默认 50
  reads?: ArtifactSelector;                             // ★ 输入：从哪种 类型+状态 取活（consume 默认用它）
  writes?: WriteSpec | WriteSpec[];                     // ★ 输出：本池会写出哪些 类型(+状态)
}
interface WriteSpec { kind: string; state?: string | string[] }   // ★ state 不填 = 该类型任意状态

pool.setConcurrency(n)
run.graph(): { edges: Edge[]; warnings: string[]; terminal: string[] }   // ★ 由 reads/writes 对出来的链路
interface Edge { from: string; to: string; kind: string; state: string; backlog: number }
// warnings：有池读、没有池声明写；terminal：有池写、没有池读（通常是终态）
```

**用法**

```ts
run.capacity("llm", { model: "anthropic/claude-sonnet-4-5", concurrency: 3 });
run.capacity("sandbox", { concurrency: 4 });

const find  = run.pool("find",  { needs: "llm", concurrency: 1, priority: 50,
                                  writes: { kind: "item", state: "new" } });
const check = run.pool("check", { needs: { llm: 1, sandbox: 1 }, concurrency: 2, priority: 10,
                                  reads:  { kind: "item", state: "new" },
                                  writes: { kind: "item", state: ["checked", "rejected"] } });

run.graph();
// edges:    [{ from: "find", to: "check", kind: "item", state: "new", backlog: 3 }]
// warnings: []
// terminal: ["check → item:checked", "check → item:rejected"]
```

**★ 声明 reads / writes 之后 SDK 会做的事**

1. **启动时连线并检查**：`run.graph()` 和 state.json 里都能看到链路。读了却没人写、写了却没人读，只给提示，不报错，因为也可能是代码在外面投放或在外面收取。
2. **写入校验**：本池的任务（不论通过工具、钩子还是 consume 里的代码）写出未声明的类型或状态时，直接报错，报错是 agent 看得懂的说明。只改字段、不改状态时，本池读或写的类型都放行。不声明 writes 的池不做校验；池外的代码（比如串行段里）也不受限制。
3. **告诉 agent 这一步要产出什么**：同一个会话可能先后在不同池里跑，所以产物工具按“当前任务所在的池”动态校验。SDK 还会在任务提示词末尾自动附一行「本步骤需登记的产出：item（checked / rejected）」，用 `TaskOptions.outputHint: false` 可以关掉。

**调度规则（固定行为）**
- **拿取顺序**：会话锁（不占资源）→ 池名额 → 按名字顺序一次拿全容量许可 → 跑 → 在 finally 里全部归还。没有嵌套加需，所以不会死锁。
- **门的规则**：老化的排最前，然后优先级小的先，同一优先级先来先得。

---

## 3. 角色与会话

```ts
interface AgentRole {
  name: string;
  system: string;                         // 系统提示词
  tools?: string[];                       // pi 内置工具，如 ["read","grep","bash","edit","write"]；不填 = 不开
  customTools?: ToolDefinition[];         // 自定义工具（pi ToolDefinition）
  artifactTool?: boolean | { kinds?: string[] };   // 注入产物工具，默认开
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

run.session(name: string, role: AgentRole): Promise<Session>   // 按名字开或复活
run.getSession(name): Session | undefined

session.name / session.file / session.role / session.parent
session.tasks(): TaskView[]           // 当前路径上跑过的任务（按周期标记重建）
session.task(taskId): TaskView | undefined
session.contextUsage()                // { tokens, contextWindow, percent }
session.entries()                     // 原始条目（调试或自定义处理用）
session.dispose()                     // 释放 pi 资源，会话文件保留

interface TaskView {
  taskId: string; label?: string;
  status: "running" | "done" | "failed" | "aborted";
  attempts: number; promptPreview: string;
  startEntry: string; endEntry?: string;
  origin: string;                     // 谁跑的：分叉继承来的任务保留原会话名
}
```

- 会话 = 一个 pi 会话文件（`workdir/sessions/<name>.jsonl`）加一个角色。系统提示词以 system 消息形式落在条目里。
- 同一会话同一时刻只跑一个 Task，第二个会排队，排队时不占资源。要并发就 `fork`。

---

## 4. 任务（Task）

```ts
pool.run(session: Session, prompt: string, opts?: TaskOptions): Promise<TaskResult>

interface TaskOptions {
  retry?: { max?: number;                                    // 含首次，默认 3
            retryPrompt?: (err, attempt, original) => string };
  priority?: number;      // 覆盖池默认
  timeoutMs?: number;     // 单次尝试超时，超时算失败、进入重试
  signal?: AbortSignal;
  label?: string;         // 观测用
  outputHint?: boolean;   // ★ 池声明了 writes 时，在提示词末尾附「本步骤需登记的产出」，默认 true
}
interface TaskResult {
  taskId: string; sessionId: string;
  output: string;         // 最后一条 assistant 回复
  attempts: number; durationMs: number;
  artifacts: Artifact[];  // 本任务期间登记的产物
}
```

- 一个 Task = 发一次提示词，跑完一个完整 turn（内部的模型调用和工具调用都算在里面）。
- 失败时：在同一会话里发一条 SDK 生成的继续提示词。这是新的周期，但仍是同一个任务。用尽次数抛 `TaskFailed`，被中止抛 `TaskAborted`。

---

## 5. 上下文：摘要 / 压缩 / 分叉

```ts
session.digest(taskIds: string | string[], spec?: SummarySpec): Promise<Digest>
session.compress(taskIds: string | string[], spec?: SummarySpec): Promise<Digest>
session.fork(opts?: ForkOptions): Promise<Session>

interface SummarySpec {
  range?: "process" | "process+output" | "all";   // 仅过程 / 过程+回复 / 含任务提示词；默认 process+output
  prompt?: string;                                // 摘要规范，放在 system 位置
  validate?: (text) => string | null;             // null = 合规；字符串 = 不合规原因 → 带着原因重试
  maxRetries?: number;                            // 默认 1
  capacity?: string;                              // 用哪个模型容量
  maxTokens?: number;
  reuse?: boolean;                                // 同会话+同任务+同程度+同提示词的旧摘要复用，默认 true
}
interface Digest { id; sessionId; tasks: string[]; range; text; promptHash; createdAt }

interface ForkOptions {
  name?: string;                      // 同名已存在 = 直接返回它（续跑幂等）
  agent?: AgentRole;                  // 子会话换角色
  inherit?: InheritPlan | false;      // false = 全新会话，只留血缘
  upTo?: string;                      // 只考虑到这个任务为止（含）
}
interface InheritPlan {
  default?: "raw" | "digest" | "skip";               // 默认 raw
  tasks?: Record<taskId, "raw" | "digest" | "skip">; // 按任务单独指定
  includeFailed?: boolean;                           // 默认 false
  digest?: SummarySpec;                              // digest 模式用的摘要参数
}
```

| 动作 | 改不改本会话 | 粒度 | 说明 |
|---|---|---|---|
| `digest` | 不改（只读） | 任意任务 | 不要求叶子退回；结果登记成 `sdk:digest` 产物 |
| `compress` | 改（只追加 `context_edit`） | 任意任务，包括中间的 | 原文仍在文件里，以后选 raw 继承还取得到 |
| `fork` | 不改，写一个新文件 | 按任务选 raw / digest / skip | raw = 整段复制（含工具调用和返回）；不复制上游 system 消息 |

```ts
const t1 = await pool.run(s, "TASK1");
const t2 = await pool.run(s, "TASK2");
const d  = await s.digest(t1.taskId, { prompt: SPEC, validate });                 // 只要 TASK1 的摘要
const c1 = await s.fork({ name: "c1", agent: B, inherit: { default: "skip", tasks: { [t1.taskId]: "raw" } } });
const c2 = await s.fork({ name: "c2", inherit: { default: "skip", tasks: { [t1.taskId]: "digest" }, digest: { prompt: SPEC } } });
```

---

## 6. 产物

### 6.1 外壳与查询

```ts
interface Artifact {
  id: string; kind: string; state: string;
  fields: Record<string, unknown>;          // 载荷一：字段
  file?: { path; sha256; bytes };           // 载荷二：文件引用
  source: ArtifactSource;                   // 来源，自动附带
  history: Array<{ at; state; source }>;    // 每次改动的来源（最多 50 条）
  createdAt; updatedAt; version;
}
interface ArtifactSource {
  runId; by: "tool" | "hook" | "code";
  sessionId?; taskId?; attempt?; pool?; item?;   // item = 消费循环里正在处理的那条
}

run.artifacts.create(kind, { fields?, state?, file?, id? }): Artifact     // state 默认 "new"
run.artifacts.update(id, { state?, fields?, file? }, { expectState? }): Artifact   // fields 浅合并，null 表示删除
run.artifacts.get(id)
run.artifacts.query({ kind, state?, where? }): Artifact[]    // 唯一读接口：选活 / 观测 / 续跑共用；按创建先后
run.artifacts.counts(): { [kind]: { [state]: n } }
run.artifacts.defineKind(kind, { states?, initial?, transitions?, required? })   // 可选约束，只校验不解释
```

### 6.2 agent 的 `artifact` 工具（默认注入）
- 动作：`create(kind, fields, state?)`、`update(id, state?, fields?)`、`get(id)`、`query(kind, state?)`。
- 来源自动带上当前任务。
- 允许写的类型：先看 `role.artifactTool.kinds`，再按★当前任务所在池的 `writes` 动态校验，两者都满足才放行。
- `sdk:` 开头的类型是保留类型，agent 不能写。

### 6.3 文件钩子

```ts
createRun({ trackFiles: [{ dir: "out/patches", kind: "patch", state: "new" }] })
```

- agent 用 write / edit 写进该目录的文件，会自动登记成一条产物，内容是相对路径、sha256 和来源。
- 同一路径只对应一条产物，内容变化时版本 +1。
- 目录外的草稿不登记。
- 用 bash 写出的文件不会被捕捉，需要用工具或代码自己登记。
- ★ 所在池没声明这种产出时：文件已经写出、退不回去，所以不登记，只发一个 `artifact:rejected` 事件。

---

## 7. 编排

```ts
run.step<T>(name, fn: () => Promise<T>): Promise<T>
// 串行记账：之前的运行里已完成 → 直接返回记下的结果（需可 JSON 序列化）；循环轮次用 step(`round-${i}`)

run.loop<T>(name, { max, until? }, body: (round) => Promise<T>): Promise<{ rounds; results: T[]; stopped: "until" | "max" }>
// 循环零件：目标（body）+ 判定（until：还要不要再来一轮）+ 上限（max）
// 每轮自动用 step 记账；续跑时已完成的轮次取回结果、用同一个 until 重新判定，从下一轮接着跑

run.parallel([job1, job2, ...]): Promise<[...results]>
// 并列：任一作业失败 → run 进入停止，等全部收尾后抛出第一个错误
// 非消费作业（如循环生产者）还在跑时，消费循环不会判定收工

pool.consume(opts: ConsumeOptions): Promise<ConsumeReport>
interface ConsumeOptions {
  handle: (item: Artifact, ctx: { pool; run; signal }) => Promise<void>;
  reads?: ArtifactSelector;    // ★ 默认取池的 reads；两边都没有时报错
  onError?: "stop" | "skip";   // 默认 stop：停整个 run（状态已落盘可续跑）；skip：本 run 跳过这条
  lanes?: number;              // 并行几路，默认 = 池并发
}
interface ConsumeReport { pool; handled; failed; stalled: string[] }
// stalled = handle 跑完却没推进状态的条目（本 run 内不再取，避免空转）
```

```ts
const brief = await run.step("init", async () => (await find.run(await run.session("init", R), "…")).output);

await run.parallel([
  () => run.loop("find", { max: 3, until: (r) => r.output.includes("没有更多") }, (i) => find.run(…)),   // 循环生产者
  () => check.consume({ handle: async (item) => {
          const s = await run.session(`check-${item.id}`, R);
          await check.run(s, `复核 ${JSON.stringify(item.fields)}`);   // agent 用 artifact 工具把 item 改成 checked/rejected
        } }),
]);
```

- 同一条产物同一时刻只会被一个消费循环处理。
- 收工 = 全局静默，四个条件同时满足：没有在跑的任务、没有在处理的条目、没有非消费作业、并且安静了 quietMs。

---

## 8. 可靠运行（行为约定，无需调用）

| 场景 | 行为 |
|---|---|
| 模型出错 / 单次超时 | 任务内重试（继续提示词，同一任务新周期），用尽抛 `TaskFailed` |
| consume 里出错 | 默认 stop：停止派活，在跑的跑完，`parallel` 抛出；`onError: "skip"` 可改为跳过 |
| 进程崩溃后同 workdir 再启动 | step 跳过；`run.session(name)` 接回原会话；没收尾的周期补 `aborted`；消费池按状态做剩下的 |
| 重复 fork 同名 | 返回已有子会话 |
| 模型被 pi 静默替换（凭证缺失） | 硬失败，报出要求的模型和实际生效的模型 |

---

## 9. 观测

```ts
run.stats()     // { runId, status, quiescent, capacities, pools, graph★, tasks: {running, recent}, artifacts, sessions, steps, events }
run.on(e => …)  // 事件：capacity:grant|release / task:start|retry|end / artifact:write|rejected / summary / fork / step / consumer:item-failed / run:stopping
```

- `workdir/state.json`：`stats()` 的落盘版，约 300ms 刷新一次。外部只读这一个文件就能看全局。
- `workdir/ledger.jsonl`：台账，记录 run / task / step / item-failed 的追加记录。
- `workdir/sessions.json`：会话名 → 文件、角色、父会话。

---

## 10. 错误类型

| 错误 | 什么时候抛 |
|---|---|
| `TaskFailed { taskId, attempts }` | 任务重试用尽 |
| `TaskAborted { taskId }` | 任务被中止 |
| `RunStopped` | run 已停止后还提交新任务 |
| `SummaryFailed` | 摘要多次不合规范 |
| `ArtifactError` | 产物校验失败（状态、迁移、必填字段、★未声明的写入） |

---

## 11. 测试辅助

```ts
const { runtime, faux } = await fauxRuntime();          // 假 provider "faux"，模型 "faux/m1"
const run = await createRun({ workdir, modelRuntime: runtime });
run.capacity("m", { model: "faux/m1", concurrency: 2 });
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("artifact", { action: "create", kind: "item", fields: {} })], { stopReason: "toolUse" }),
  fauxAssistantMessage("完成"),
  (ctx) => fauxAssistantMessage(`按上下文生成：${ctx.messages.length}`),
]);
```

---

## 12. 当前边界（已知、有意为之）

- **单进程**：产物存储和会话锁都在进程内，不支持多个进程同时跑同一个 workdir。
- **文件钩子只看 write / edit**：bash 写出的文件要自己登记。
- **摘要的定位**：摘要过容量门（占模型名额），但不进池、不算 Task。
- **一个池最多一个模型容量**：Task 用的模型就是它。
- **没做**：速率 / 预算型资源、汇合原语、会话间通信、人工确认。
