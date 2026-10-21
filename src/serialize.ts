/**
 * 上下文：把一段条目按"摘要程度"裁剪后序列化成文本，喂给摘要器。
 *
 * 一个任务段 = [启动标记 → 任务提示词 → 过程(assistant/工具调用/工具返回/思考) → 回复 → 结束标记]
 *   process         只留过程
 *   process+output  过程 + 最终回复
 *   all             再加任务提示词（含重试时 SDK 发的继续提示词）
 */

import type { SummaryRange } from "./types.ts";
import { clip } from "./util.ts";

export const CYCLE_TYPE = "sdk.cycle";
export const DIGEST_TYPE = "sdk.digest";

/** pi 条目的最小形状（不依赖 pi 的内部类型，便于测试） */
export interface EntryLike {
  id: string;
  parentId: string | null;
  type: string;
  [k: string]: unknown;
}

export interface CycleData {
  phase: "start" | "end";
  taskId: string;
  attempt: number;
  /** 起源会话（分叉继承过来的任务保留原会话名） */
  session: string;
  label?: string;
  prompt?: string;
  status?: "done" | "failed" | "aborted";
  error?: string;
}

export function cycleData(e: EntryLike): CycleData | undefined {
  if (e.type !== "custom" || e.customType !== CYCLE_TYPE) return undefined;
  return e.data as CycleData;
}

type Part = "prompt" | "process" | "reply" | "meta";

/** 给段内每个条目标上它属于哪一部分 */
export function classify(segment: EntryLike[]): Array<{ e: EntryLike; part: Part }> {
  const out: Array<{ e: EntryLike; part: Part }> = [];
  let expectPrompt = false;
  let lastAssistantIdx = -1;
  for (const e of segment) {
    const cd = cycleData(e);
    if (cd) {
      out.push({ e, part: "meta" });
      if (cd.phase === "start") {
        expectPrompt = true;
        lastAssistantIdx = -1;
      } else if (cd.status === "done" && lastAssistantIdx >= 0) {
        // 每个成功周期的最后一条 assistant = 该任务的回复
        out[lastAssistantIdx]!.part = "reply";
        lastAssistantIdx = -1;
      }
      continue;
    }
    if (e.type === "message") {
      const role = (e.message as { role?: string } | undefined)?.role;
      if (role === "system") {
        out.push({ e, part: "meta" });
        continue;
      }
      if (role === "user" && expectPrompt) {
        out.push({ e, part: "prompt" });
        expectPrompt = false;
        continue;
      }
      if (role === "assistant") lastAssistantIdx = out.length;
      out.push({ e, part: "process" });
      continue;
    }
    if (e.type === "custom_message" || e.type === "branch_summary" || e.type === "compaction") {
      out.push({ e, part: "process" });
      continue;
    }
    out.push({ e, part: "meta" });
  }
  return out;
}

function keep(part: Part, range: SummaryRange): boolean {
  if (part === "meta") return false;
  if (range === "all") return true;
  if (range === "process+output") return part !== "prompt";
  return part === "process";
}

export function serializeSegment(segment: EntryLike[], range: SummaryRange): string {
  const lines: string[] = [];
  for (const { e, part } of classify(segment)) {
    if (!keep(part, range)) continue;
    const text = renderEntry(e, part);
    if (text) lines.push(text);
  }
  return lines.join("\n\n");
}

function renderEntry(e: EntryLike, part: Part): string {
  if (e.type === "message") {
    const m = e.message as { role?: string; content?: unknown; toolName?: string };
    const role = m.role ?? "?";
    const title = part === "prompt" ? "## user（任务提示词）" : part === "reply" ? "## assistant（回复）" : role === "toolResult" ? `## 工具返回${m.toolName ? `（${m.toolName}）` : ""}` : `## ${role}`;
    const parts = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [{ type: "text", text: String(m.content ?? "") }];
    const body: string[] = [];
    for (const p of parts) {
      if (p.type === "text") body.push(clip(String(p.text ?? ""), role === "toolResult" ? 2000 : 4000));
      else if (p.type === "thinking") body.push(`[思考] ${clip(String(p.thinking ?? ""), 800)}`);
      else if (p.type === "toolCall") body.push(`[调用工具 ${String(p.name)}] ${clip(JSON.stringify(p.arguments ?? {}), 1500)}`);
      else if (p.type === "image") body.push("[图片]");
    }
    return body.length ? `${title}\n${body.join("\n")}` : "";
  }
  if (e.type === "custom_message") {
    const c = e.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("\n") : "";
    return `## 注入消息\n${clip(text, 4000)}`;
  }
  if (e.type === "branch_summary" || e.type === "compaction") {
    return `## 前序摘要\n${clip(String(e.summary ?? ""), 6000)}`;
  }
  return "";
}

export const DEFAULT_SUMMARY_PROMPT = `你是会话历史摘要器。把下面这段 agent 会话历史压缩成结构化摘要，供后续任务继承上下文。
要求：
1. 每个任务按「任务目标 → 完成的事实（产出、结论、改动清单）→ 关键依据（判断理由、代码位置 file:line）」记录；
2. 丢弃中间推演、重复内容、试错与回退；
3. 不确定或未完成的地方明确标出，不要补全或猜测。
输出 markdown，按任务分节，语言与原会话一致。`;
