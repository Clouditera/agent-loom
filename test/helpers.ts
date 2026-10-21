import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRun, type Run, type RunOptions } from "../src/index.ts";
import { fauxAssistantMessage, fauxRuntime } from "../src/testing.ts";

export const TMP_ROOT = join(import.meta.dirname, "..", ".tmp-test");
/** 每个测试文件用自己的一棵子树，互不影响 */
const SUITE = (process.argv[1] ?? "suite").split("/").pop()!.replace(/\.test\.ts$/, "");

let seq = 0;
export function tmpDir(name: string): string {
  const d = join(TMP_ROOT, SUITE, `${name}-${process.pid}-${++seq}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}
export function suiteRoot(): string {
  return join(TMP_ROOT, SUITE);
}

export async function mkRun(name: string, opts: Partial<RunOptions> = {}) {
  const dir = opts.workdir ?? tmpDir(name);
  const cwd = opts.cwd ?? join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const { runtime, faux } = await fauxRuntime({ dir });
  const run = await createRun({ workdir: join(dir, "run"), cwd, modelRuntime: runtime, quietMs: 150, pollMs: 50, ...opts });
  run.capacity("m", { model: "faux/m1", concurrency: 2 });
  return { run, faux, dir, cwd, runtime };
}

/** 把一次请求的上下文压成便于断言的字符串数组 */
export function msgs(ctx: any): string[] {
  return ctx.messages.map((m: any) => {
    const c = typeof m.content === "string" ? m.content : (m.content ?? []).map((x: any) => x.text ?? x.name ?? x.type).join("+");
    if (m.role === "system") return `system:${Object.values(m.sections ?? {}).join("|")}${c}`;
    return `${m.role}:${c}`;
  });
}

export function systemText(ctx: any): string {
  return msgs(ctx).filter((s) => s.startsWith("system:")).join("\n");
}

/** n 个"直接回复"的响应 */
export function replies(n: number, text: string | ((ctx: any) => string) = "ok", delayMs = 0) {
  return Array.from({ length: n }, () => async (ctx: any) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return fauxAssistantMessage(typeof text === "function" ? text(ctx) : text);
  });
}

export async function closeAll(...runs: Run[]) {
  for (const r of runs) await r.close();
}
