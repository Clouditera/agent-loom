/**
 * 支柱① 上下文：Session = 一个 pi 会话文件（条目树）+ 一个角色。
 *
 * 会话组成（pi 1.3.0 实测）：系统提示词以 system 消息落进条目树（首次全量、之后补丁）；
 * 任务周期的边界由 SDK 写成 custom 条目（不进 LLM 上下文，随条目树走）。
 *
 * 能力：
 *   tasks()   看这个会话跑过哪些任务（按周期标记重建，续跑时天然还原）
 *   digest()  旁路摘要：只读，按任务取一段历史、调模型、登记成产物；不改会话、不要求叶子退回
 *   compress()原位压缩：用 pi 的 context_edit 把任意任务段替换成摘要（只追加、可撤回）
 *   fork()    分叉：落新会话文件；按任务选 原文 / 摘要 / 不带；可换角色
 *
 * 并发铁律：同一会话同一时刻只有一个 Task 在写（lock）。要并发 → fork 成不同会话。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve, sep, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ArtifactStore } from "./artifacts.ts";
import { CYCLE_TYPE, DIGEST_TYPE, cycleData, DEFAULT_SUMMARY_PROMPT, serializeSegment, type CycleData, type EntryLike } from "./serialize.ts";
import type { AgentRole, ArtifactSource, Digest, ForkOptions, InheritPlan, RunEvent, SummarySpec, TakeMode, TaskView, ThinkingLevel } from "./types.ts";
import { ArtifactError } from "./types.ts";
import { clip, hashText, Mutex, sha256 } from "./util.ts";

export const DIGEST_KIND = "sdk:digest";

export interface TrackFiles {
  /** 相对 run.cwd 的目录；agent 用 write/edit 写进这里的文件会被自动登记 */
  dir: string;
  kind: string;
  state?: string;
}

/** Session 需要从 Run 拿的东西（避免循环依赖） */
export interface SessionHost {
  runId: string;
  cwd: string;
  workdir: string;
  modelRuntime: import("@earendil-works/pi-coding-agent").ModelRuntime;
  artifacts: ArtifactStore;
  piSettings: Record<string, unknown>;
  trackFiles: TrackFiles[];
  emit(e: RunEvent): void;
  summarize(text: string, spec: SummarySpec): Promise<string>;
  findSession(name: string): Session | undefined;
  createSessionFile(name: string, entries: EntryLike[], parentFile?: string): string;
  registerSession(s: Session): void;
}

export interface PromptOutcome {
  ok: boolean;
  output: string;
  error?: string;
  aborted?: boolean;
}

export class Session {
  readonly name: string;
  readonly file: string;
  readonly role: AgentRole;
  readonly parent?: string;
  /** 同一会话同一时刻只允许一个 Task */
  readonly lock = new Mutex();
  /** @internal 当前在跑的任务（产物工具 / 文件钩子据此自动填来源） */
  current?: { taskId: string; attempt: number; pool: string; item?: string; written: string[] };

  private host: SessionHost;
  private sm: SessionManager;
  private agent?: AgentSession;
  private agentModelKey?: string;
  private unsubscribe?: () => void;
  private pendingArgs = new Map<string, Record<string, unknown>>();

  private constructor(host: SessionHost, name: string, role: AgentRole, file: string, parent?: string) {
    this.host = host;
    this.name = name;
    this.role = role;
    this.file = file;
    this.parent = parent;
    this.sm = SessionManager.open(file, join(host.workdir, "sessions"), host.cwd);
  }

  /** @internal 打开（或复活）会话文件；上次进程退出时没收尾的任务补一个 aborted 结束标记 */
  static open(host: SessionHost, name: string, role: AgentRole, file: string, parent?: string): Session {
    const s = new Session(host, name, role, file, parent);
    for (const t of s.tasks()) {
      if (t.status !== "running") continue;
      s.appendCycle({ phase: "end", taskId: t.taskId, attempt: t.attempts, session: t.origin, status: "aborted", error: "上次进程退出时任务未完成" });
    }
    return s;
  }

  // ------------------------------------------------------------ 只读

  /** 这个会话（当前路径上）跑过的任务，按先后顺序 */
  tasks(): TaskView[] {
    const views = new Map<string, TaskView>();
    for (const e of this.branch()) {
      const cd = cycleData(e);
      if (!cd) continue;
      let v = views.get(cd.taskId);
      if (cd.phase === "start") {
        if (!v) {
          v = { taskId: cd.taskId, label: cd.label, status: "running", attempts: 0, promptPreview: clip(cd.prompt ?? "", 80), startEntry: e.id, origin: cd.session };
          views.set(cd.taskId, v);
        }
        v.attempts = Math.max(v.attempts, cd.attempt);
        v.status = "running";
      } else if (v) {
        v.status = cd.status ?? "done";
        v.endEntry = e.id;
      }
    }
    return [...views.values()];
  }

  task(taskId: string): TaskView | undefined {
    return this.tasks().find((t) => t.taskId === taskId);
  }

  /** pi 报告的上下文占用（未跑过任务时为 undefined） */
  contextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    return this.agent?.getContextUsage() as { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  }

  /** 当前路径上的全部条目（调试 / 自定义处理用） */
  entries(): EntryLike[] {
    return this.branch();
  }

  // ------------------------------------------------------------ 摘要

  /**
   * 旁路摘要：只读。按任务编号取那一段历史 → 按程度裁剪 → 调模型（过容量门）→ 登记成 sdk:digest 产物。
   * 同会话 + 同任务 + 同程度 + 同提示词 的旧摘要默认直接复用。
   */
  async digest(taskIds: string | string[], spec: SummarySpec = {}): Promise<Digest> {
    const ids = [taskIds].flat();
    if (ids.length === 0) throw new Error("digest：至少给一个任务编号");
    const views = this.requireTasks(ids);
    for (const v of views) if (v.status === "running") throw new Error(`digest：任务 ${v.taskId} 还在跑`);
    const range = spec.range ?? "process+output";
    const prompt = spec.prompt ?? DEFAULT_SUMMARY_PROMPT;
    const promptHash = hashText(prompt);
    const id = `digest:${this.name}:${hashText(`${ids.join(",")}|${range}|${promptHash}`)}`;

    const cached = this.host.artifacts.get(id);
    if (cached && spec.reuse !== false) {
      this.host.emit({ type: "summary", session: this.name, tasks: ids, mode: "digest", reused: true });
      return toDigest(cached.fields);
    }

    const history = ids.map((tid) => serializeSegment(this.segment(tid), range)).filter(Boolean).join("\n\n---\n\n");
    const text = await this.host.summarize(
      `以下是要摘要的会话历史（任务 ${ids.join(", ")}）：\n\n${history || "（这段没有可摘要的内容）"}`,
      { ...spec, prompt },
    );
    const d: Digest = { id, sessionId: this.name, tasks: ids, range, text, promptHash, createdAt: Date.now() };
    const source: ArtifactSource = { runId: this.host.runId, by: "code", sessionId: this.name };
    if (cached) this.host.artifacts.update(id, { fields: { ...d } }, source);
    else this.host.artifacts.create(DIGEST_KIND, { id, state: "ready", fields: { ...d } }, source);
    this.host.emit({ type: "summary", session: this.name, tasks: ids, mode: "digest", reused: false });
    return d;
  }

  /**
   * 原位压缩：先拿（或复用）这些任务的摘要，再用 pi 的 context_edit
   * 把这段历史在本会话上下文里替换成摘要。原条目仍在文件里，以后选"原文继承"照样取得到。
   */
  async compress(taskIds: string | string[], spec: SummarySpec = {}): Promise<Digest> {
    const release = await this.lock.lock();
    try {
      const ids = [taskIds].flat();
      const d = await this.digest(ids, spec);
      const targets = ids.flatMap((tid) => this.segment(tid)).filter(isContextEntry);
      if (targets.length > 0) {
        this.sm.appendContextEdit(targets[0]!.id, { content: `[已压缩 · 任务 ${ids.join(", ")}]\n\n${d.text}` } as never);
        for (const e of targets.slice(1)) this.sm.appendContextEdit(e.id, null);
      }
      this.host.emit({ type: "summary", session: this.name, tasks: ids, mode: "compress", reused: false });
      return d;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------ 分叉

  /**
   * 分叉：写一个新会话文件，按任务选 原文(raw) / 摘要(digest) / 不带(skip)。
   * 原文 = 整段任务逐条复制（含工具调用与返回、周期标记）；上游的 system 消息不复制，
   * 子会话第一次请求时写入自己的系统提示词 → 可换角色。
   * 同名分叉已存在时直接返回它（续跑时幂等）。
   */
  async fork(opts: ForkOptions = {}): Promise<Session> {
    const name = opts.name ?? `${this.name}~${randomBytes(3).toString("hex")}`;
    const existing = this.host.findSession(name);
    if (existing) return existing;

    let views = this.tasks();
    if (opts.upTo) {
      const i = views.findIndex((v) => v.taskId === opts.upTo);
      if (i < 0) throw new Error(`fork：会话 ${this.name} 上没有任务 ${opts.upTo}`);
      views = views.slice(0, i + 1);
    }
    const entries: EntryLike[] = [];
    const plan = opts.inherit === false ? undefined : (opts.inherit ?? {});
    if (plan) {
      const known = new Set(views.map((v) => v.taskId));
      for (const tid of Object.keys(plan.tasks ?? {})) {
        if (!known.has(tid)) throw new Error(`fork：继承方案里的任务 ${tid} 不在会话 ${this.name} 上`);
      }
      // 相邻、同为 digest 的任务合并成一次摘要
      const groups: Array<{ mode: TakeMode; ids: string[] }> = [];
      for (const v of views) {
        if (v.status === "running") continue;
        if (v.status !== "done" && !plan.includeFailed) continue;
        const mode = plan.tasks?.[v.taskId] ?? plan.default ?? "raw";
        if (mode === "skip") continue;
        const last = groups.at(-1);
        if (last && last.mode === mode) last.ids.push(v.taskId);
        else groups.push({ mode, ids: [v.taskId] });
      }
      for (const g of groups) {
        if (g.mode === "raw") {
          for (const tid of g.ids) entries.push(...this.segment(tid).filter(isRawCopyable).map((e) => structuredClone(e)));
        } else {
          const d = await this.digest(g.ids, plan.digest ?? {});
          entries.push(digestEntry(d));
        }
      }
    }
    const file = this.host.createSessionFile(name, entries, this.file);
    const child = Session.open(this.host, name, opts.agent ?? this.role, file, this.name);
    this.host.registerSession(child);
    this.host.emit({ type: "fork", parent: this.name, child: name, inherit: plan ? describePlan(plan) : "none" });
    return child;
  }

  // ------------------------------------------------------------ 给 Task 用（内部）

  /** @internal */
  async ensureAgent(model: Model<any>, thinking: ThinkingLevel): Promise<AgentSession> {
    const key = `${model.provider}/${model.id}`;
    if (!this.agent) {
      const custom: ToolDefinition<any, any, any>[] = [...(this.role.customTools ?? [])];
      if (this.role.artifactTool !== false) custom.push(this.makeArtifactTool());
      const toolNames = [...(this.role.tools ?? []), ...custom.map((t) => t.name)];
      const { session } = await createAgentSession({
        cwd: this.host.cwd,
        agentDir: join(this.host.workdir, "agent"),
        model,
        thinkingLevel: thinking,
        modelRuntime: this.host.modelRuntime,
        resourceLoader: makeLoader(this.role.system),
        tools: toolNames,
        customTools: custom,
        sessionManager: this.sm,
        settingsManager: SettingsManager.inMemory(this.host.piSettings as never),
      });
      // 模型回退守卫：pi 在凭证缺失时可能静默换成别的模型，这里硬失败
      const got = session.model ? `${session.model.provider}/${session.model.id}` : "（无）";
      if (got !== key) {
        session.dispose();
        throw new Error(`模型回退：要求 ${key}，实际生效 ${got}。请检查该 provider 的凭证。`);
      }
      this.agent = session;
      this.agentModelKey = key;
      this.unsubscribe = session.subscribe((ev) => this.onEvent(ev as unknown as Record<string, unknown>));
    } else if (this.agentModelKey !== key) {
      await this.agent.setModel(model);
      this.agentModelKey = key;
    }
    this.agent.setThinkingLevel(thinking);
    return this.agent;
  }

  /** @internal */
  appendCycle(data: CycleData): string {
    return this.sm.appendCustomEntry(CYCLE_TYPE, data);
  }

  /** @internal 发一次提示词，等这一轮彻底结束；模型错误不抛，返回失败原因 */
  async promptOnce(text: string, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<PromptOutcome> {
    const agent = this.agent;
    if (!agent) throw new Error("内部错误：会话还没有绑定模型");
    const before = agent.messages.length;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => void agent.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        void agent.abort();
      }, opts.timeoutMs);
    }
    try {
      await agent.prompt(text);
      await agent.waitForIdle();
    } catch (e) {
      if (opts.signal?.aborted) return { ok: false, output: "", aborted: true, error: "已中止" };
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (opts.signal?.aborted) return { ok: false, output: "", aborted: true, error: "已中止" };
    if (timedOut) return { ok: false, output: "", error: `单次尝试超时（${opts.timeoutMs}ms）` };
    const fresh = agent.messages.slice(before) as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
    const last = [...fresh].reverse().find((m) => m.role === "assistant");
    if (!last) return { ok: false, output: "", error: "模型没有回复" };
    if (last.stopReason === "error") return { ok: false, output: "", error: last.errorMessage || "模型返回错误" };
    if (last.stopReason === "aborted") return { ok: false, output: "", aborted: true, error: "已中止" };
    return { ok: true, output: agent.getLastAssistantText() ?? "" };
  }

  /** 释放 pi 会话资源（会话文件保留，可再次打开） */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.agent?.dispose();
    this.agent = undefined;
    this.agentModelKey = undefined;
  }

  // ------------------------------------------------------------ 私有

  private branch(): EntryLike[] {
    return this.sm.getBranch() as unknown as EntryLike[];
  }

  private requireTasks(ids: string[]): TaskView[] {
    const all = new Map(this.tasks().map((t) => [t.taskId, t]));
    return ids.map((id) => {
      const v = all.get(id);
      if (!v) throw new Error(`会话 ${this.name} 上没有任务 ${id}`);
      return v;
    });
  }

  /** 一个任务的整段：第一次尝试的启动标记 … 最后一次尝试的结束标记（含两端） */
  private segment(taskId: string): EntryLike[] {
    const branch = this.branch();
    let start = -1;
    let end = -1;
    branch.forEach((e, i) => {
      const cd = cycleData(e);
      if (!cd || cd.taskId !== taskId) return;
      if (cd.phase === "start" && start < 0) start = i;
      if (cd.phase === "end") end = i;
    });
    if (start < 0) throw new Error(`会话 ${this.name} 上没有任务 ${taskId}`);
    return branch.slice(start, (end >= 0 ? end : branch.length - 1) + 1);
  }

  private source(by: ArtifactSource["by"]): ArtifactSource {
    const c = this.current;
    return { runId: this.host.runId, by, sessionId: this.name, taskId: c?.taskId, attempt: c?.attempt, pool: c?.pool, item: c?.item };
  }

  /** 工具钩子：write / edit 落进登记目录的文件 → 自动登记（文件引用 + 哈希 + 来源） */
  private onEvent(ev: Record<string, unknown>): void {
    const type = ev.type;
    if (type === "tool_execution_start") {
      this.pendingArgs.set(String(ev.toolCallId), (ev.args ?? {}) as Record<string, unknown>);
      return;
    }
    if (type !== "tool_execution_end") return;
    const args = this.pendingArgs.get(String(ev.toolCallId));
    this.pendingArgs.delete(String(ev.toolCallId));
    if (ev.isError || !args) return;
    const tool = String(ev.toolName);
    if (tool !== "write" && tool !== "edit") return;
    const p = typeof args.path === "string" ? args.path : undefined;
    if (!p || this.host.trackFiles.length === 0) return;
    const abs = resolve(this.host.cwd, p);
    for (const t of this.host.trackFiles) {
      const dir = resolve(this.host.cwd, t.dir);
      if (!(abs === dir || abs.startsWith(dir + sep))) continue;
      if (!existsSync(abs)) return;
      const buf = readFileSync(abs);
      const a = this.host.artifacts.upsertFile(t.kind, { path: relative(this.host.cwd, abs), sha256: sha256(buf), bytes: buf.length }, this.source("hook"), t.state);
      this.current?.written.push(a.id);
      return;
    }
  }

  /** 产物工具：agent 通过它登记 / 推进 / 查询产物；来源自动带上当前任务 */
  private makeArtifactTool(): ToolDefinition<any, any, any> {
    const cfg = typeof this.role.artifactTool === "object" ? this.role.artifactTool : {};
    const allowed = cfg.kinds ? new Set(cfg.kinds) : undefined;
    const store = this.host.artifacts;
    const checkKind = (kind: string) => {
      if (kind.startsWith("sdk:")) throw new ArtifactError(`类型 ${kind} 是 SDK 保留类型，不能通过工具写`);
      if (allowed && !allowed.has(kind)) throw new ArtifactError(`本角色只能操作这些类型：${[...allowed].join(", ")}`);
    };
    const brief = (a: { id: string; kind: string; state: string; fields: unknown; file?: unknown }) => ({ id: a.id, kind: a.kind, state: a.state, fields: a.fields, file: a.file });
    const kindsHint = allowed ? `可用类型：${[...allowed].join(", ")}。` : "";
    return defineTool({
      name: "artifact",
      label: "artifact",
      description:
        `登记 / 推进 / 查询工作流产物。凡是要交给后续步骤处理的结果，都必须用它登记。${kindsHint}` +
        "action=create 新建（kind, fields, 可选 state）；update 改状态或合并字段（id, state?, fields?）；get 读一条（id）；query 按类型与状态查（kind, state?）。",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("get"), Type.Literal("query")]),
        kind: Type.Optional(Type.String({ description: "产物类型" })),
        id: Type.Optional(Type.String({ description: "产物编号（update/get）" })),
        state: Type.Optional(Type.String({ description: "状态（create 可选，update 改状态，query 过滤）" })),
        fields: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "字段（create 全量，update 浅合并，值为 null 删除）" })),
      }),
      execute: async (_id, p) => {
        try {
          let out: unknown;
          if (p.action === "create") {
            if (!p.kind) throw new ArtifactError("create 需要 kind");
            checkKind(p.kind);
            const a = store.create(p.kind, { fields: p.fields as Record<string, unknown> | undefined, state: p.state }, this.source("tool"));
            this.current?.written.push(a.id);
            out = brief(a);
          } else if (p.action === "update") {
            if (!p.id) throw new ArtifactError("update 需要 id");
            const cur = store.get(p.id);
            if (!cur) throw new ArtifactError(`找不到产物 ${p.id}；可先 query`);
            checkKind(cur.kind);
            const a = store.update(p.id, { state: p.state, fields: p.fields as Record<string, unknown> | undefined }, this.source("tool"));
            this.current?.written.push(a.id);
            out = brief(a);
          } else if (p.action === "get") {
            if (!p.id) throw new ArtifactError("get 需要 id");
            const a = store.get(p.id);
            if (!a) throw new ArtifactError(`找不到产物 ${p.id}`);
            out = brief(a);
          } else {
            if (!p.kind) throw new ArtifactError("query 需要 kind");
            if (allowed && !allowed.has(p.kind)) throw new ArtifactError(`本角色只能查询这些类型：${[...allowed].join(", ")}`);
            const list = store.query({ kind: p.kind, state: p.state });
            out = { total: list.length, items: list.slice(0, 50).map(brief) };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }], details: {} };
        } catch (e) {
          return { content: [{ type: "text" as const, text: `错误：${e instanceof Error ? e.message : String(e)}` }], details: {}, isError: true };
        }
      },
    });
  }
}

// ---------------------------------------------------------------- 辅助

function makeLoader(system: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => system,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function isContextEntry(e: EntryLike): boolean {
  if (e.type === "custom_message") return true;
  if (e.type !== "message") return false;
  const role = (e.message as { role?: string } | undefined)?.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

/** 原文继承复制哪些条目：非 system 消息、周期标记、注入消息、分支摘要 */
function isRawCopyable(e: EntryLike): boolean {
  if (e.type === "message") return (e.message as { role?: string } | undefined)?.role !== "system";
  if (e.type === "custom") return e.customType === CYCLE_TYPE;
  return e.type === "custom_message" || e.type === "branch_summary";
}

function digestEntry(d: Digest): EntryLike {
  return {
    type: "custom_message",
    id: randomBytes(4).toString("hex"),
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: DIGEST_TYPE,
    content: `[上游摘要 · 会话 ${d.sessionId} · 任务 ${d.tasks.join(", ")}]\n\n${d.text}`,
    display: false,
    details: { digestId: d.id, tasks: d.tasks },
  };
}

function toDigest(f: Record<string, unknown>): Digest {
  return f as unknown as Digest;
}

function describePlan(p: InheritPlan): string {
  const per = Object.entries(p.tasks ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
  return `default=${p.default ?? "raw"}${per ? `;${per}` : ""}`;
}

/** @internal 写会话文件：头部 + 条目（重串 parentId）。给 Run.createSessionFile 用 */
export function writeSessionFile(path: string, cwd: string, entries: EntryLike[], parentFile?: string): void {
  if (existsSync(path)) throw new Error(`会话文件已存在：${path}`);
  const header: Record<string, unknown> = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
  if (parentFile) header.parentSession = parentFile;
  const lines = [JSON.stringify(header)];
  let parent: string | null = null;
  for (const e of entries) {
    lines.push(JSON.stringify({ ...e, parentId: parent }));
    parent = e.id;
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}
