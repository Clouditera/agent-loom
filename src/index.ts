/**
 * agent-loom —— 轻量 agent 工作流 SDK（建在 pi ≥ 1.2 之上）
 *
 *   ① 上下文   Session：任务周期 / 旁路摘要 digest / 原位压缩 compress / 分叉继承 fork
 *   ② 并行调度 Capacity（真闸门）/ Pool（只限流）/ Task（一次 prompt 一份许可）/ consume（状态驱动）
 *   ③ 可靠运行 同目录续跑 / step 串行记账 / 任务内重试 / 全局静默收工 / state.json 观测
 */

export { createRun, Run, Pool } from "./run.ts";
export type { RunOptions, ConsumeOptions, ConsumeContext, ConsumeReport } from "./run.ts";
export { Session, DIGEST_KIND } from "./session.ts";
export type { TrackFiles } from "./session.ts";
export { Capacity } from "./sched.ts";
export type { Permit } from "./sched.ts";
export { DEFAULT_SUMMARY_PROMPT, serializeSegment } from "./serialize.ts";
export type { CreateInput, UpdateInput } from "./artifacts.ts";
export * from "./types.ts";
