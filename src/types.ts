/**
 * 公共类型。只认识：容量 / 池 / 会话 / 任务 / 产物。不认识任何具体业务。
 */

import type { Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions, CreateAgentSessionServicesOptions, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

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

/**
 * SDK 强制接管的 pi 创建选项 —— 这几样由 SDK 管，不能由角色指定：
 *   会话文件（周期标记 / 摘要 / 分叉 / 续跑）、模型（随容量许可）、注入产物工具与事件、
 *   创建时机与释放。其余 pi 选项一律直通。
 */
type ManagedOptions = "sessionManager" | "model" | "modelRuntime" | "thinkingLevel" | "scopedModels" | "agentDir" | "sessionStartEvent";

/**
 * 资源加载选项（不传 resourceLoader 时，SDK 用它们构造 pi 的 DefaultResourceLoader）。
 * 去掉了自动发现开关和资产路径：自动发现由 SDK 全关，资产在角色上声明（skills / extensions / prompts / context）。
 */
export type PiResourceOptions = Omit<
  NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>,
  DiscoveryOptions | AssetOptions
>;

/** pi 的自动发现开关 —— SDK 固定全关，不能改 */
type DiscoveryOptions = "noExtensions" | "noSkills" | "noPromptTemplates" | "noThemes" | "noContextFiles";
/** pi 的资产路径 —— 改由角色上的 skills / extensions / prompts 声明 */
type AssetOptions = "additionalExtensionPaths" | "additionalSkillPaths" | "additionalPromptTemplatePaths" | "extensionFactories";

/**
 * 可以原样交给 pi 的选项：createAgentSession 的选项（去掉 SDK 接管的）+ 资源加载选项
 * （systemPrompt / appendSystemPrompt / *Override 钩子 / eventBus …）。
 */
export type PiAgentOptions = Omit<CreateAgentSessionOptions, ManagedOptions> & PiResourceOptions;

/** 资产路径：绝对路径、相对路径（相对进程 cwd）、file: URL（如 new URL("./skills", import.meta.url)），或 npm: / git: 包源 */
export type AssetPath = string | URL;

/** 上下文文件（等同 AGENTS.md）：给路径就读文件，或直接给内容 */
export type ContextAsset = AssetPath | { name: string; content: string };

export interface AgentRole {
  name: string;
  /** 系统提示词：pi 没带基础提示词时它就是基础提示词；带了（pi.systemPrompt / pi.resourceLoader）就追加在后 */
  system: string;

  // ---- 资产：pi 的自动发现（cwd 的 .pi/ .agents/、~/.agents、AGENTS.md、APPEND_SYSTEM.md…）全关，只用这里声明的

  /** skills：SKILL.md 所在目录，或包含多个 skill 目录的父目录 */
  skills?: AssetPath[];
  /** 扩展：扩展文件 / 目录 / 包源，或内联的扩展工厂 (pi) => void */
  extensions?: Array<AssetPath | ExtensionFactory>;
  /** 提示词模板：.md 文件或目录；任务里发 /名字 会展开 */
  prompts?: AssetPath[];
  /** 上下文文件（等同 AGENTS.md），按顺序放进系统提示词 */
  context?: ContextAsset[];

  // ---- 工具

  /** 要开哪些工具（白名单）：pi 内置工具、扩展注册的工具都写这里；产物工具和 customTools 自动并入 */
  tools?: string[];
  /** 额外自定义工具；和 pi.customTools 合并 */
  customTools?: ToolDefinition<any, any, any>[];
  /** 注入 SDK 的产物工具（默认开）；可限定允许写的类型 */
  artifactTool?: boolean | { kinds?: string[] };
  /** 思考强度；不填用容量上模型串里的，再不填 "medium" */
  thinking?: ThinkingLevel;

  /**
   * 其余 pi 选项原样直通：excludeTools、settingsManager、cwd、systemPrompt、appendSystemPrompt、*Override 钩子……
   * 也可以是工厂，按当前模型 / 会话名决定。SDK 接管的（会话文件、模型、思考强度、agentDir）和自动发现开关不能写。
   */
  pi?: PiAgentOptions | ((ctx: { model: Model<any>; sessionName: string }) => PiAgentOptions | Promise<PiAgentOptions>);
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
