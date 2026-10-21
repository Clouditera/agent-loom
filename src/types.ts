/**
 * 公共类型。只认识：容量 / 池 / 会话 / 任务 / 产物。不认识任何具体业务。
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** 数字越小 = 越下游 = 越优先（缺省 50） */
export type Priority = number;

/** "provider/model" 或 "provider/model:thinking"，或直接给 pi 的 Model 对象 */
export type ModelRef = string | Model<any>;

// ---------------------------------------------------------------- 并行调度

export interface CapacityOptions {
  /** 绑定模型 → 这是一个"模型容量"；不填 = 普通资源（沙箱机位等） */
  model?: ModelRef;
  /** 同时几路。由外部能力决定（凭证并发 / 机位数），是真闸门 */
  concurrency: number;
  /** 等待超过此毫秒数视同最高优先（防饿死）。默认 15 分钟 */
  agingMs?: number;
}

export interface PoolOptions {
  /** 需要哪些容量：名字、名字列表、或 {名字: 份数}。一个池最多需要一个模型容量 */
  needs?: string | string[] | Record<string, number>;
  /** 池自己的上限，只限流。真实并发 = min(池, 容量) */
  concurrency: number;
  /** 默认优先级（越小越优先，表示越下游） */
  priority?: Priority;
  /** 输入：从哪种 类型+状态 取活（consume 默认用它） */
  reads?: ArtifactSelector;
  /** 输出：本池会写出哪些 类型(+状态)。声明了就校验：本池任务写出未声明的类型/状态会报错 */
  writes?: WriteSpec | WriteSpec[];
}

/** 输出声明：state 不填 = 该类型任意状态 */
export interface WriteSpec {
  kind: string;
  state?: string | string[];
}

/** 由各池 reads / writes 对出来的一段链路 */
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  /** "*" = 任意状态 */
  state: string;
  /** 这一段此刻积压了多少条（匹配下游 reads 的产物数） */
  backlog: number;
}

export interface PoolGraph {
  edges: GraphEdge[];
  /** 有池读、没有池声明写（若由池外代码投放可忽略） */
  warnings: string[];
  /** 有池写、没有池读：通常是终态产出 */
  terminal: string[];
}

// ---------------------------------------------------------------- 角色 / 任务

export interface AgentRole {
  name: string;
  /** 系统提示词 */
  system: string;
  /** 开启的 pi 内置工具，如 ["read","grep","bash","edit","write"]；不填 = 不开内置工具 */
  tools?: string[];
  /** 自定义工具（pi ToolDefinition） */
  customTools?: ToolDefinition<any, any, any>[];
  /** 注入 SDK 的产物工具（默认开）；可限定允许写的类型 */
  artifactTool?: boolean | { kinds?: string[] };
  /** 思考强度；不填用容量上模型串里的，再不填 "medium" */
  thinking?: ThinkingLevel;
}

export interface RetryPolicy {
  /** 最多尝试几次（含首次）。默认 3 */
  max?: number;
  /** 第 2 次起的继续提示词；不填用 SDK 默认 */
  retryPrompt?: (err: string, attempt: number, original: string) => string;
}

export interface TaskOptions {
  retry?: RetryPolicy;
  /** 覆盖池的默认优先级 */
  priority?: Priority;
  /** 单次尝试超时（毫秒），超时视为失败、进入重试 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 便于观测的短标签 */
  label?: string;
  /** 池声明了 writes 时，在提示词末尾附「本步骤需登记的产出」，默认 true */
  outputHint?: boolean;
}

export interface TaskResult {
  taskId: string;
  sessionId: string;
  /** 最后一条 assistant 回复的文本 */
  output: string;
  attempts: number;
  durationMs: number;
  /** 本任务期间登记的产物 */
  artifacts: Artifact[];
}

// ---------------------------------------------------------------- 产物

export interface FileRef {
  /** 相对 run.cwd 的路径 */
  path: string;
  sha256: string;
  bytes: number;
}

/** 来源：SDK 自动附带，使用者不填 */
export interface ArtifactSource {
  runId: string;
  by: "tool" | "hook" | "code";
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  pool?: string;
  /** 若在消费循环里写：正在处理的那条产物 */
  item?: string;
}

export interface Artifact<F extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: string;
  state: string;
  fields: F;
  file?: FileRef;
  source: ArtifactSource;
  /** 每次改动的来源都追加在这里（最多保留 50 条） */
  history: Array<{ at: number; state: string; source: ArtifactSource }>;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface ArtifactSelector {
  kind: string;
  state?: string | string[];
  where?: (a: Artifact) => boolean;
}

/** 类型约束（可选）：声明了就校验，不声明就不管 */
export interface KindSpec {
  /** 允许的状态 */
  states?: string[];
  /** 新建时的默认状态；不填 "new" */
  initial?: string;
  /** 允许的状态迁移 from → [to...]；不填 = 任意 */
  transitions?: Record<string, string[]>;
  /** 必填字段 */
  required?: string[];
}

// ---------------------------------------------------------------- 上下文

/** 摘要程度：仅过程 / 过程+回复 / 全部（含任务提示词） */
export type SummaryRange = "process" | "process+output" | "all";

export interface SummarySpec {
  /** 默认 "process+output" */
  range?: SummaryRange;
  /** 摘要规范（进 system 位置）；不填用 SDK 默认 */
  prompt?: string;
  /** null = 合规；字符串 = 不合规原因 → 带着原因重试 */
  validate?: (text: string) => string | null;
  /** 不合规时重试几次，默认 1 */
  maxRetries?: number;
  /** 用哪个模型容量做摘要；不填用 run 的 summaryCapacity，再不填用第一个模型容量 */
  capacity?: string;
  maxTokens?: number;
  /** 同会话 + 同任务 + 同 range + 同提示词 的旧摘要直接复用（默认 true） */
  reuse?: boolean;
}

export type TakeMode = "raw" | "digest" | "skip";

export interface InheritPlan {
  /** 没单独指定的任务用它；默认 "raw" */
  default?: TakeMode;
  /** 按任务单独指定 */
  tasks?: Record<string, TakeMode>;
  /** 失败的任务也带上（默认 false） */
  includeFailed?: boolean;
  /** digest 模式用的摘要参数 */
  digest?: SummarySpec;
}

export interface ForkOptions {
  /** 新会话名（同一 run 内唯一）；不填自动生成 */
  name?: string;
  /** 子会话换角色；不填沿用父会话 */
  agent?: AgentRole;
  /** 继承方案；false = 全新会话（只留血缘） */
  inherit?: InheritPlan | false;
  /** 只考虑到这个任务为止（含）；不填 = 当前全部 */
  upTo?: string;
}

export interface TaskView {
  taskId: string;
  label?: string;
  status: "running" | "done" | "failed" | "aborted";
  attempts: number;
  promptPreview: string;
  /** 第一次尝试的启动标记条目 id */
  startEntry: string;
  /** 最后一次尝试的结束标记条目 id */
  endEntry?: string;
  /** 谁跑的：分叉继承来的任务保留原会话名 */
  origin: string;
}

export interface Digest {
  id: string;
  sessionId: string;
  tasks: string[];
  range: SummaryRange;
  text: string;
  promptHash: string;
  createdAt: number;
}

// ---------------------------------------------------------------- 事件 / 观测

export type RunEvent =
  | { type: "capacity:grant"; capacity: string; tag: string; waitedMs: number }
  | { type: "capacity:release"; capacity: string; tag: string; heldMs: number }
  | { type: "task:start"; taskId: string; pool: string; session: string; attempt: number; label?: string }
  | { type: "task:retry"; taskId: string; pool: string; attempt: number; reason: string }
  | { type: "task:end"; taskId: string; pool: string; status: "done" | "failed" | "aborted"; attempts: number; ms: number; error?: string }
  | { type: "artifact:write"; id: string; kind: string; state: string; prev?: string; by: ArtifactSource["by"] }
  | { type: "artifact:rejected"; kind: string; path?: string; reason: string; by: ArtifactSource["by"]; taskId?: string }
  | { type: "summary"; session: string; tasks: string[]; mode: "digest" | "compress"; reused: boolean }
  | { type: "fork"; parent: string; child: string; inherit: string }
  | { type: "step"; name: string; status: "skipped" | "done" | "failed" }
  | { type: "consumer:item-failed"; pool: string; item: string; error: string }
  | { type: "run:stopping"; reason: string };

export type TimedEvent = RunEvent & { ts: number };

// ---------------------------------------------------------------- 错误

export class TaskFailed extends Error {
  readonly taskId: string;
  readonly attempts: number;
  constructor(taskId: string, attempts: number, cause: string) {
    super(`任务 ${taskId} 在 ${attempts} 次尝试后失败：${cause}`);
    this.name = "TaskFailed";
    this.taskId = taskId;
    this.attempts = attempts;
  }
}

export class TaskAborted extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`任务 ${taskId} 被中止`);
    this.name = "TaskAborted";
    this.taskId = taskId;
  }
}

export class SummaryFailed extends Error {
  constructor(reason: string) {
    super(`摘要不合规范：${reason}`);
    this.name = "SummaryFailed";
  }
}

export class ArtifactError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ArtifactError";
  }
}

export class RunStopped extends Error {
  constructor(reason: string) {
    super(`run 已停止：${reason}`);
    this.name = "RunStopped";
  }
}
