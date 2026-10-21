/**
 * 小工具：编号、原子写、哈希、截断、唤醒器。
 * 与业务无关，SDK 各层共用。
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 短随机 id：前缀 + 时间 + 随机，便于肉眼排序与区分 */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashText(s: string | undefined): string {
  return sha256(s ?? "").slice(0, 16);
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[截断, 原长 ${s.length}]`;
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** 原子写：tmp + rename，崩溃时不会留下半个文件 */
export function atomicWriteJSON(p: string, obj: unknown): void {
  ensureDir(dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${randomBytes(2).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, p);
}

export function readJSON<T>(p: string): T | undefined {
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function appendJSONL(p: string, row: unknown): void {
  ensureDir(dirname(p));
  appendFileSync(p, `${JSON.stringify(row)}\n`);
}

export function readJSONL<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 半行（崩溃时写到一半）直接跳过 */
    }
  }
  return out;
}

export function abortError(msg = "已中止"): Error {
  const e = new Error(msg);
  e.name = "AbortError";
  return e;
}

/**
 * 唤醒器：等"有新动静"或超时。
 * 消费循环没活时用它睡觉；任何产物写入、任务结束都会 notify。
 */
export class Notifier {
  private waiters = new Set<() => void>();

  notify(): void {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/** 简单互斥锁：同一会话同一时刻只允许一个 Task 写 */
export class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  get isLocked(): boolean {
    return this.locked;
  }

  async lock(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (!this.locked) {
      this.locked = true;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.queue.indexOf(go);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(go);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}
