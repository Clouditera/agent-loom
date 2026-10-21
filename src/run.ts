/**
 * Run：一次工作流运行的总入口。把三根支柱装到一起：
 *   ① 上下文   run.session() / session.digest / compress / fork
 *   ② 并行调度 run.capacity() / run.pool() / pool.run() / pool.consume() / run.parallel()
 *   ③ 可靠运行 续跑（同一 workdir 再启动）/ run.step() 串行记账 / 任务内重试 / 全局静默收工 / state.json 观测
 *
 * 先后用 await，并列用 run.parallel；池与池之间不连线，靠产物"类型 + 状态"接力。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ArtifactStore, type CreateInput, type UpdateInput } from "./artifacts.ts";
import { acquireAll, Capacity, normalizeNeeds, PoolGate, type Permit } from "./sched.ts";
import { DEFAULT_SUMMARY_PROMPT, type EntryLike } from "./serialize.ts";
import { Session, writeSessionFile, type SessionHost, type TrackFiles } from "./session.ts";
import {
  RunStopped,
  SummaryFailed,
  TaskAborted,
  TaskFailed,
  type AgentRole,
  type Artifact,
  type ArtifactSelector,
  type ArtifactSource,
  type CapacityOptions,
  type KindSpec,
  type ModelRef,
  type PoolOptions,
  type Priority,
  type RunEvent,
  type SummarySpec,
  type TaskOptions,
  type TaskResult,
  type ThinkingLevel,
  type TimedEvent,
} from "./types.ts";
import { appendJSONL, atomicWriteJSON, ensureDir, newId, Notifier, readJSON, readJSONL } from "./util.ts";

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface RunOptions {
  /** 运行目录：产物、会话、台账、state.json 都落这里。同一目录再启动 = 续跑 */
  workdir: string;
  /** agent 的工作目录（内置工具的根）。默认 process.cwd() */
  cwd?: string;
  /** pi 的模型运行时。默认 ModelRuntime.create()（读 ~/.pi/agent 下的凭证与 models.json） */
  modelRuntime?: ModelRuntime;
  /** 摘要默认用哪个模型容量；不填用第一个声明的模型容量 */
  summaryCapacity?: string;
  /** 文件钩子：agent 用 write/edit 写进这些目录的文件自动登记成产物 */
  trackFiles?: TrackFiles[];
  /** 透传给 pi 的 SettingsManager.inMemory（默认开启 pi 自身的瞬时错误重试与上下文压缩） */
  piSettings?: Record<string, unknown>;
  /** 全局静默判定的安静窗口（毫秒），默认 1500 */
  quietMs?: number;
  /** 消费循环没活时的轮询间隔（毫秒），默认 1000（有新产物写入会立刻唤醒） */
  pollMs?: number;
}

export interface ConsumeOptions {
  /** 从什么状态取活 */
  reads: ArtifactSelector;
  /** 处理一条：通常在里面开 / 分叉会话、跑一个 Task、推进这条产物的状态 */
  handle: (item: Artifact, ctx: ConsumeContext) => Promise<void>;
  /** 某条处理失败时：stop（默认）= 停整个 run，状态已落盘可续跑；skip = 本 run 内跳过这条继续 */
  onError?: "stop" | "skip";
  /** 并行几路；默认 = 池并发上限 */
  lanes?: number;
}

export interface ConsumeContext {
  pool: Pool;
  run: Run;
  signal: AbortSignal;
}

export interface ConsumeReport {
  pool: string;
  handled: number;
  failed: number;
  /** handle 跑完但没推进状态的条目（本 run 内不再取，避免空转） */
  stalled: string[];
}

interface LedgerRow {
  t: "run" | "task" | "step" | "item-failed";
  [k: string]: unknown;
}

interface SessionMeta {
  file: string;
  role: string;
  parent?: string;
  createdAt: number;
}

interface TaskRecord {
  taskId: string;
  pool: string;
  session: string;
  label?: string;
  item?: string;
  attempt: number;
  startedAt: number;
  status?: "done" | "failed" | "aborted";
  endedAt?: number;
  error?: string;
}

/** 消费循环里的上下文：代码里写产物时自动带上 "哪个池在处理哪条" */
const laneCtx = new AsyncLocalStorage<{ pool: string; item: string }>();

export async function createRun(opts: RunOptions): Promise<Run> {
  const runtime = opts.modelRuntime ?? (await ModelRuntime.create());
  return new Run(opts, runtime);
}

export class Run {
  readonly id: string;
  readonly workdir: string;
  readonly cwd: string;
  readonly modelRuntime: ModelRuntime;
  /** 代码里读写产物（来源自动记为 code，在消费循环里还会带上池与条目） */
  readonly artifacts: {
    defineKind(kind: string, spec: KindSpec): void;
    create(kind: string, input?: CreateInput): Artifact;
    update(id: string, input: UpdateInput, opts?: { expectState?: string | string[] }): Artifact;
    get(id: string): Artifact | undefined;
    query(sel: ArtifactSelector): Artifact[];
    counts(): Record<string, Record<string, number>>;
  };

  private store: ArtifactStore;
  private capacities = new Map<string, Capacity>();
  private pools = new Map<string, Pool>();
  private sessions = new Map<string, Session>();
  private sessionMeta: Record<string, SessionMeta>;
  private steps = new Map<string, { result: unknown; at: number }>();
  private listeners = new Set<(e: TimedEvent) => void>();
  private events: TimedEvent[] = [];
  private summaryCapacity?: string;
  private trackFiles: TrackFiles[];
  private piSettings: Record<string, unknown>;
  private quietMs: number;
  /** @internal */ readonly pollMs: number;
  /** @internal */ readonly notifier = new Notifier();
  /** @internal */ readonly claims = new Set<string>();
  /** @internal */ inflight = 0;
  /** @internal */ activeItems = 0;
  /** @internal */ openJobs = 0;
  /** @internal */ openConsumes = 0;
  /** @internal */ lastActivity = Date.now();
  /** @internal */ readonly running = new Map<string, TaskRecord>();
  private recent: TaskRecord[] = [];
  private stopCtl = new AbortController();
  private abortCtl = new AbortController();
  private status: "running" | "stopping" | "closed" = "running";
  private stopReason?: string;
  private startedAt = Date.now();
  private stateTimer?: ReturnType<typeof setTimeout>;
  private host: SessionHost;

  /** @internal 用 createRun() */
  constructor(opts: RunOptions, runtime: ModelRuntime) {
    this.workdir = opts.workdir;
    this.cwd = opts.cwd ?? process.cwd();
    this.modelRuntime = runtime;
    this.summaryCapacity = opts.summaryCapacity;
    this.trackFiles = opts.trackFiles ?? [];
    this.piSettings = opts.piSettings ?? { compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } };
    this.quietMs = opts.quietMs ?? 1500;
    this.pollMs = opts.pollMs ?? 1000;
    ensureDir(join(this.workdir, "sessions"));

    // 续跑：读台账（已完成的串行步）与会话表
    const rows = readJSONL<LedgerRow>(this.ledgerPath);
    const prevRuns = rows.filter((r) => r.t === "run").length;
    this.id = `run-${prevRuns + 1}-${Date.now().toString(36)}`;
    for (const r of rows) if (r.t === "step" && r.status === "done") this.steps.set(String(r.name), { result: r.result, at: Number(r.at) });
    this.sessionMeta = readJSON<Record<string, SessionMeta>>(join(this.workdir, "sessions.json")) ?? {};
    appendJSONL(this.ledgerPath, { t: "run", runId: this.id, at: Date.now(), resumed: prevRuns > 0 });

    this.store = new ArtifactStore(join(this.workdir, "artifacts"), (e) => this.emit(e), () => this.touch());
    this.artifacts = {
      defineKind: (kind, spec) => this.store.defineKind(kind, spec),
      create: (kind, input = {}) => this.store.create(kind, input, this.codeSource()),
      update: (id, input, o) => this.store.update(id, input, this.codeSource(), o),
      get: (id) => this.store.get(id),
      query: (sel) => this.store.query(sel),
      counts: () => this.store.counts(),
    };

    const self = this;
    this.host = {
      runId: this.id,
      cwd: this.cwd,
      workdir: this.workdir,
      modelRuntime: runtime,
      artifacts: this.store,
      piSettings: this.piSettings,
      trackFiles: this.trackFiles,
      emit: (e) => self.emit(e),
      summarize: (text, spec) => self.summarize(text, spec),
      findSession: (name) => self.findSession(name),
      createSessionFile: (name, entries, parentFile) => self.createSessionFile(name, entries, parentFile),
      registerSession: (s) => self.registerSession(s),
    };
    this.writeState();
  }

  // ------------------------------------------------------------ 声明

  /** 声明资源。带 model = 模型容量（凭证并发）；不带 = 普通资源（沙箱机位等） */
  capacity(name: string, opts: CapacityOptions): Capacity {
    const existing = this.capacities.get(name);
    if (existing) {
      existing.setConcurrency(opts.concurrency);
      return existing;
    }
    let model: Model<any> | undefined;
    let thinking: ThinkingLevel | undefined;
    if (opts.model !== undefined) ({ model, thinking } = this.resolveModel(opts.model));
    const cap = new Capacity(name, { concurrency: opts.concurrency, agingMs: opts.agingMs, model, thinking }, (e) => this.emit(e));
    this.capacities.set(name, cap);
    this.dirty();
    return cap;
  }

  /** 声明池（同名返回已有的）。池只限流，真实并发 = min(池, 容量) */
  pool(name: string, opts: PoolOptions): Pool {
    const existing = this.pools.get(name);
    if (existing) return existing;
    const needs = normalizeNeeds(opts.needs);
    for (const n of needs) if (!this.capacities.has(n.capacity)) throw new Error(`池 ${name} 需要的容量 ${n.capacity} 还没声明`);
    const models = needs.filter((n) => this.capacities.get(n.capacity)!.model);
    if (models.length > 1) throw new Error(`池 ${name} 需要了多个模型容量（${models.map((m) => m.capacity).join(", ")}），一个池最多一个`);
    const p = new Pool(this, name, needs, opts.concurrency, opts.priority ?? 50);
    this.pools.set(name, p);
    this.dirty();
    return p;
  }

  /** 开或复活一个会话（按名字）。同一 workdir 再启动时自动接上原会话文件 */
  async session(name: string, role: AgentRole): Promise<Session> {
    const live = this.sessions.get(name);
    if (live) return live;
    const meta = this.sessionMeta[name];
    const file = meta?.file ?? this.createSessionFile(name, []);
    const s = Session.open(this.host, name, role, file, meta?.parent);
    this.registerSession(s);
    return s;
  }

  getSession(name: string): Session | undefined {
    return this.sessions.get(name);
  }

  // ------------------------------------------------------------ 编排

  /**
   * 并列跑：任一作业失败 → 整个 run 进入停止（不再派新活，在跑的跑完），等全部收尾后抛出第一个错误。
   * 非消费作业（如循环型生产者）还在跑时，消费循环不会判定收工。
   */
  async parallel<T extends readonly (() => Promise<unknown>)[]>(jobs: T): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    const settled = await Promise.allSettled(
      jobs.map(async (job) => {
        this.openJobs++;
        try {
          return await job();
        } catch (e) {
          this.stop(`并列作业失败：${errMsg(e)}`);
          throw e;
        } finally {
          this.openJobs--;
          this.touch();
        }
      }),
    );
    const bad = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (bad) throw bad.reason;
    return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as never;
  }

  /**
   * 串行记账：同名步骤在之前的运行里完成过 → 直接返回记下的结果，不再执行。
   * 结果需可 JSON 序列化。循环轮次可用 step(`round-${i}`, ...)。
   */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const done = this.steps.get(name);
    if (done) {
      this.emit({ type: "step", name, status: "skipped" });
      return done.result as T;
    }
    try {
      const result = await fn();
      const at = Date.now();
      this.steps.set(name, { result: result ?? null, at });
      appendJSONL(this.ledgerPath, { t: "step", name, status: "done", result: result ?? null, at });
      this.emit({ type: "step", name, status: "done" });
      return result;
    } catch (e) {
      this.emit({ type: "step", name, status: "failed" });
      throw e;
    }
  }

  /** 平稳停止：不再派新活，在跑的跑完 */
  stop(reason: string): void {
    if (this.status !== "running") return;
    this.status = "stopping";
    this.stopReason = reason;
    this.emit({ type: "run:stopping", reason });
    this.stopCtl.abort();
    this.notifier.notify();
  }

  /** 立即中止：停止 + 打断在跑的任务 */
  abort(reason = "手动中止"): void {
    this.stop(reason);
    this.abortCtl.abort();
  }

  get stopping(): boolean {
    return this.status !== "running";
  }

  /** @internal */
  get abortSignal(): AbortSignal {
    return this.abortCtl.signal;
  }

  /** @internal */
  get stopSignal(): AbortSignal {
    return this.stopCtl.signal;
  }

  /** 收尾：释放所有 pi 会话，写最终状态 */
  async close(): Promise<void> {
    for (const s of this.sessions.values()) s.dispose();
    this.status = "closed";
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.writeState();
  }

  // ------------------------------------------------------------ 观测

  on(fn: (e: TimedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 一个接口看全局：容量 / 池 / 在跑与最近的任务 / 产物计数 / 会话 / 串行步。state.json 是它的落盘版 */
  stats() {
    return {
      runId: this.id,
      status: this.status,
      stopReason: this.stopReason,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      cwd: this.cwd,
      quiescent: this.isQuiescent(),
      capacities: [...this.capacities.values()].map((c) => c.stats()),
      pools: [...this.pools.values()].map((p) => p.stats()),
      tasks: { running: [...this.running.values()], recent: this.recent.slice(-30) },
      artifacts: this.store.counts(),
      sessions: Object.entries(this.sessionMeta).map(([name, m]) => ({ name, role: m.role, parent: m.parent, file: m.file })),
      steps: [...this.steps.entries()].map(([name, s]) => ({ name, at: s.at })),
      events: this.events.slice(-50),
    };
  }

  // ------------------------------------------------------------ 内部

  /** @internal 收工判断 = 全局静默：没有在跑的任务、没有在处理的条目、没有非消费作业、安静了一小会儿 */
  isQuiescent(): boolean {
    return (
      this.inflight === 0 &&
      this.activeItems === 0 &&
      this.openJobs - this.openConsumes <= 0 &&
      Date.now() - this.lastActivity >= this.quietMs
    );
  }

  /** @internal 取活：按选择器查，排除别的消费循环正在处理的、本循环已判定卡住的 */
  pick(sel: ArtifactSelector, exclude: Set<string>): Artifact | undefined {
    return this.store.query(sel).find((a) => !this.claims.has(a.id) && !exclude.has(a.id));
  }

  /** @internal */
  capacityOf(name: string): Capacity {
    const c = this.capacities.get(name);
    if (!c) throw new Error(`未声明的容量 ${name}`);
    return c;
  }

  /** @internal */
  touch(): void {
    this.lastActivity = Date.now();
    this.notifier.notify();
    this.dirty();
  }

  /** @internal */
  emit(e: RunEvent): void {
    const te = { ...e, ts: Date.now() } as TimedEvent;
    this.events.push(te);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    for (const l of this.listeners) {
      try {
        l(te);
      } catch {
        /* 监听器出错不影响运行 */
      }
    }
    this.dirty();
  }

  /** @internal */
  ledger(row: LedgerRow): void {
    appendJSONL(this.ledgerPath, { ...row, runId: this.id });
  }

  /** @internal */
  taskStarted(r: TaskRecord): void {
    this.running.set(r.taskId, r);
    this.dirty();
  }

  /** @internal */
  taskEnded(r: TaskRecord): void {
    this.running.delete(r.taskId);
    this.recent.push(r);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    this.ledger({ t: "task", ...r });
    this.touch();
  }

  /** @internal 摘要：过容量门（不变量①），提示词进 system，不合规带原因重试 */
  async summarize(text: string, spec: SummarySpec): Promise<string> {
    const capName = spec.capacity ?? this.summaryCapacity ?? [...this.capacities.values()].find((c) => c.model)?.name;
    if (!capName) throw new Error("没有可用于摘要的模型容量：请先 run.capacity(name, { model, concurrency })");
    const cap = this.capacityOf(capName);
    if (!cap.model) throw new Error(`容量 ${capName} 没有绑定模型，不能做摘要`);
    const model = cap.model;
    const permit = await cap.acquire(`summary:${newId("s")}`, 20, this.abortSignal);
    this.inflight++;
    try {
      const maxTokens = spec.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32_000) : 16_000);
      const reasoning = model.reasoning && cap.thinking && cap.thinking !== "off" ? cap.thinking : undefined;
      let lastBad: string | null = null;
      const maxRetries = spec.maxRetries ?? 1;
      for (let i = 0; i <= maxRetries; i++) {
        const content = lastBad ? `上一次输出不合规范：${lastBad}\n请修正后重新输出。\n\n---\n\n${text}` : text;
        const out = await this.completeWithRetry(model, spec.prompt ?? DEFAULT_SUMMARY_PROMPT, content, maxTokens, reasoning);
        const bad = spec.validate?.(out) ?? null;
        if (!bad) return out;
        lastBad = bad;
      }
      throw new SummaryFailed(lastBad ?? "未知");
    } finally {
      permit.release();
      this.inflight--;
      this.touch();
    }
  }

  private async completeWithRetry(model: Model<any>, system: string, user: string, maxTokens: number, reasoning?: ThinkingLevel): Promise<string> {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const msg = await this.modelRuntime.completeSimple(
        model,
        { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
        { maxTokens, reasoning: reasoning as never, signal: this.abortSignal },
      );
      if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
        return msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("").trim();
      }
      if (msg.stopReason === "aborted") throw new Error("摘要被中止");
      last = msg.errorMessage ?? "模型错误";
    }
    throw new Error(`摘要模型调用失败：${last}`);
  }

  private resolveModel(ref: ModelRef): { model: Model<any>; thinking?: ThinkingLevel } {
    if (typeof ref !== "string") return { model: ref };
    let spec = ref;
    let thinking: ThinkingLevel | undefined;
    const colon = ref.lastIndexOf(":");
    if (colon > 0 && THINKING.has(ref.slice(colon + 1))) {
      thinking = ref.slice(colon + 1) as ThinkingLevel;
      spec = ref.slice(0, colon);
    }
    const slash = spec.indexOf("/");
    if (slash <= 0) throw new Error(`模型写法应为 "provider/model[:thinking]"，收到 ${ref}`);
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const model = this.modelRuntime.getModel(provider, id);
    if (!model) {
      const known = this.modelRuntime.getModels(provider).map((m) => m.id).slice(0, 10);
      throw new Error(`找不到模型 ${provider}/${id}${known.length ? `；该 provider 下有：${known.join(", ")}` : "；该 provider 未注册"}`);
    }
    return { model, thinking };
  }

  private codeSource(): ArtifactSource {
    const lane = laneCtx.getStore();
    return { runId: this.id, by: "code", pool: lane?.pool, item: lane?.item };
  }

  private findSession(name: string): Session | undefined {
    return this.sessions.get(name);
  }

  private createSessionFile(name: string, entries: EntryLike[], parentFile?: string): string {
    if (this.sessionMeta[name] || this.sessions.has(name)) throw new Error(`会话名 ${name} 已被占用`);
    if (!/^[\w.~-]+$/.test(name)) throw new Error(`会话名只能用字母、数字、_ . ~ -：${name}`);
    const file = join(this.workdir, "sessions", `${name}.jsonl`);
    writeSessionFile(file, this.cwd, entries, parentFile);
    return file;
  }

  private registerSession(s: Session): void {
    this.sessions.set(s.name, s);
    if (!this.sessionMeta[s.name]) {
      this.sessionMeta[s.name] = { file: s.file, role: s.role.name, parent: s.parent, createdAt: Date.now() };
      atomicWriteJSON(join(this.workdir, "sessions.json"), this.sessionMeta);
    }
    this.dirty();
  }

  private get ledgerPath(): string {
    return join(this.workdir, "ledger.jsonl");
  }

  private dirty(): void {
    if (this.stateTimer || this.status === "closed") return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.writeState();
    }, 300);
    this.stateTimer.unref?.();
  }

  private writeState(): void {
    try {
      atomicWriteJSON(join(this.workdir, "state.json"), this.stats());
    } catch {
      /* 观测写失败不影响运行 */
    }
  }
}

// ================================================================ 池

export class Pool {
  readonly name: string;
  readonly priority: Priority;
  private owner: Run;
  private needs: Array<{ capacity: string; count: number }>;
  private gate: PoolGate;
  private consumers: Array<{ reads: ArtifactSelector; report: ConsumeReport; active: number }> = [];

  /** @internal 用 run.pool() */
  constructor(run: Run, name: string, needs: Array<{ capacity: string; count: number }>, concurrency: number, priority: Priority) {
    this.owner = run;
    this.name = name;
    this.needs = needs;
    this.gate = new PoolGate(name, concurrency);
    this.priority = priority;
  }

  setConcurrency(n: number): void {
    this.gate.setConcurrency(n);
  }

  /**
   * 跑一个 Task：对会话发一次提示词，等这一轮结束。
   * 顺序：会话锁（不占资源）→ 池名额 → 一次拿全容量许可 → 跑 → finally 全部归还。
   * 失败时在同一会话里重发 SDK 生成的继续提示词（新周期、同一个任务），用尽抛 TaskFailed。
   */
  async run(session: Session, prompt: string, opts: TaskOptions = {}): Promise<TaskResult> {
    const run = this.owner;
    if (run.stopping) throw new RunStopped("不再接受新任务");
    const caps = this.needs.map((n) => ({ cap: run.capacityOf(n.capacity), count: n.count }));
    const modelCap = caps.find((c) => c.cap.model)?.cap;
    if (!modelCap?.model) throw new Error(`池 ${this.name} 没有模型容量，不能跑 Task（needs 里加一个带 model 的容量）`);

    const taskId = newId("t");
    const lane = laneCtx.getStore();
    const signal = anySignal([opts.signal, run.abortSignal]);
    const maxAttempts = Math.max(1, opts.retry?.max ?? 3);
    const priority = opts.priority ?? this.priority;
    const tag = `${this.name}:${taskId}`;
    const rec: TaskRecord = { taskId, pool: this.name, session: session.name, label: opts.label, item: lane?.item, attempt: 0, startedAt: Date.now() };

    let releaseSession: (() => void) | undefined;
    let admitted = false;
    let permits: Permit[] = [];
    let status: "done" | "failed" | "aborted" = "failed";
    let lastErr = "";
    run.inflight++;
    run.taskStarted(rec);
    try {
      releaseSession = await session.lock.lock(signal);
      await this.gate.admit(tag, signal);
      admitted = true;
      permits = await acquireAll(caps, tag, priority, signal);
      await session.ensureAgent(modelCap.model, session.role.thinking ?? modelCap.thinking ?? "medium");
      session.current = { taskId, attempt: 0, pool: this.name, item: lane?.item, written: [] };

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        rec.attempt = attempt;
        session.current.attempt = attempt;
        const text = attempt === 1 ? prompt : (opts.retry?.retryPrompt ?? defaultRetryPrompt)(lastErr, attempt, prompt);
        session.appendCycle({ phase: "start", taskId, attempt, session: session.name, label: opts.label, prompt: text.slice(0, 400) });
        run.emit({ type: "task:start", taskId, pool: this.name, session: session.name, attempt, label: opts.label });
        const r = await session.promptOnce(text, { signal, timeoutMs: opts.timeoutMs });
        if (r.ok) {
          session.appendCycle({ phase: "end", taskId, attempt, session: session.name, status: "done" });
          status = "done";
          const written = [...new Set(session.current.written)];
          return {
            taskId,
            sessionId: session.name,
            output: r.output,
            attempts: attempt,
            durationMs: Date.now() - rec.startedAt,
            artifacts: written.map((id) => run.artifacts.get(id)).filter((a): a is Artifact => !!a),
          };
        }
        if (r.aborted) {
          session.appendCycle({ phase: "end", taskId, attempt, session: session.name, status: "aborted", error: r.error });
          status = "aborted";
          throw new TaskAborted(taskId);
        }
        session.appendCycle({ phase: "end", taskId, attempt, session: session.name, status: "failed", error: r.error });
        lastErr = r.error ?? "未知错误";
        if (attempt < maxAttempts) run.emit({ type: "task:retry", taskId, pool: this.name, attempt, reason: lastErr });
      }
      throw new TaskFailed(taskId, maxAttempts, lastErr);
    } catch (e) {
      if (signal.aborted && !(e instanceof TaskAborted)) {
        status = "aborted";
        throw new TaskAborted(taskId);
      }
      if (!(e instanceof TaskFailed) && !(e instanceof TaskAborted)) lastErr = errMsg(e);
      throw e;
    } finally {
      session.current = undefined;
      for (const p of permits) p.release();
      if (admitted) this.gate.release(tag, status === "done");
      releaseSession?.();
      run.inflight--;
      rec.status = status;
      rec.endedAt = Date.now();
      if (status !== "done") rec.error = lastErr;
      run.emit({ type: "task:end", taskId, pool: this.name, status, attempts: rec.attempt, ms: rec.endedAt - rec.startedAt, error: rec.error });
      run.taskEnded(rec);
    }
  }

  /**
   * 常驻消费：从持久状态里取活（不看上游是否完成），多路并行处理，全局静默时返回。
   * 同一条产物同一时刻只会被一个消费循环处理。
   */
  async consume(opts: ConsumeOptions): Promise<ConsumeReport> {
    const run = this.owner;
    const report: ConsumeReport = { pool: this.name, handled: 0, failed: 0, stalled: [] };
    const entry = { reads: opts.reads, report, active: 0 };
    this.consumers.push(entry);
    const stalled = new Set<string>();
    let firstError: unknown;
    const lanes = Math.max(1, opts.lanes ?? this.gate.concurrency);
    run.openConsumes++;
    try {
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          while (!run.stopping) {
            let item = run.pick(opts.reads, stalled);
            if (!item) {
              if (run.isQuiescent()) {
                item = run.pick(opts.reads, stalled);
                if (!item) return;
              } else {
                await run.notifier.wait(run.pollMs, run.stopSignal);
                continue;
              }
            }
            await this.handleItem(item, opts, entry, stalled, (e) => {
              firstError ??= e;
            });
          }
        }),
      );
    } finally {
      run.openConsumes--;
      run.touch();
    }
    if (firstError) throw firstError;
    return report;
  }

  private async handleItem(
    item: Artifact,
    opts: ConsumeOptions,
    entry: { reads: ArtifactSelector; report: ConsumeReport; active: number },
    stalled: Set<string>,
    fail: (e: unknown) => void,
  ): Promise<void> {
    const run = this.owner;
    run.claims.add(item.id);
    run.activeItems++;
    entry.active++;
    try {
      await laneCtx.run({ pool: this.name, item: item.id }, () => opts.handle(item, { pool: this, run, signal: run.abortSignal }));
      entry.report.handled++;
      // handle 跑完仍匹配选择器 = 没推进状态 → 本 run 内不再取，避免空转
      const now = run.artifacts.get(item.id);
      if (now && run.artifacts.query(opts.reads).some((a) => a.id === now.id)) {
        stalled.add(item.id);
        entry.report.stalled.push(item.id);
      }
    } catch (e) {
      entry.report.failed++;
      run.ledger({ t: "item-failed", pool: this.name, item: item.id, error: errMsg(e), at: Date.now() });
      run.emit({ type: "consumer:item-failed", pool: this.name, item: item.id, error: errMsg(e) });
      if ((opts.onError ?? "stop") === "stop") {
        fail(e);
        run.stop(`池 ${this.name} 处理 ${item.id} 失败：${errMsg(e)}`);
      } else {
        stalled.add(item.id);
      }
    } finally {
      run.claims.delete(item.id);
      run.activeItems--;
      entry.active--;
      run.touch();
    }
  }

  stats() {
    return {
      ...this.gate.stats(),
      priority: this.priority,
      needs: this.needs,
      consumers: this.consumers.map((c) => ({ reads: { kind: c.reads.kind, state: c.reads.state }, active: c.active, ...c.report })),
    };
  }
}

// ================================================================ 辅助

function defaultRetryPrompt(err: string, attempt: number): string {
  return `上一次执行中断（第 ${attempt - 1} 次尝试，原因：${err.slice(0, 300)}）。请核对当前进展，从未完成处继续完成原任务，不要重复已经完成的部分。`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  if (list.length === 1) return list[0]!;
  return AbortSignal.any(list);
}
