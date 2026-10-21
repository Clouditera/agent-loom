/**
 * 支柱② 并行调度：容量（真闸门）+ 门（授让规则）+ 池（只限流）。
 *
 * 三条不变量：
 *   ① 任何模型调用都不绕过容量（Task 与摘要都走这里）；
 *   ② 释放保证：拿到的许可在 finally 里一定归还，重复归还只生效一次；
 *   ③ 没有嵌套加需：Task 开始时按名字顺序一次拿全，内部不再申请 → 不会死锁。
 */

import type { Model } from "@earendil-works/pi-ai";
import type { Priority, RunEvent, ThinkingLevel } from "./types.ts";
import { abortError } from "./util.ts";

const DEFAULT_AGING_MS = 15 * 60_000;

export interface Permit {
  readonly capacity: string;
  readonly tag: string;
  release(): void;
}

interface Waiter {
  tag: string;
  priority: Priority;
  since: number;
  resolve: (p: Permit) => void;
  reject: (e: unknown) => void;
  cleanup?: () => void;
}

export class Capacity {
  readonly name: string;
  /** 模型容量才有 */
  readonly model?: Model<any>;
  readonly thinking?: ThinkingLevel;
  private limit: number;
  private agingMs: number;
  private held = new Map<string, number>(); // tag → since
  private waiters: Waiter[] = [];
  private emit: (e: RunEvent) => void;

  constructor(
    name: string,
    opts: { concurrency: number; agingMs?: number; model?: Model<any>; thinking?: ThinkingLevel },
    emit: (e: RunEvent) => void,
  ) {
    this.name = name;
    this.limit = Math.max(1, Math.floor(opts.concurrency));
    this.agingMs = opts.agingMs ?? DEFAULT_AGING_MS;
    this.model = opts.model;
    this.thinking = opts.thinking;
    this.emit = emit;
  }

  get total(): number {
    return this.limit;
  }

  /** 运行期调整：扩容立即多授让；缩容等在跑的自然归还 */
  setConcurrency(n: number): void {
    this.limit = Math.max(1, Math.floor(n));
    this.pump();
  }

  acquire(tag: string, priority: Priority, signal?: AbortSignal): Promise<Permit> {
    if (signal?.aborted) return Promise.reject(abortError("等待容量被中止"));
    if (this.held.size < this.limit && this.waiters.length === 0) return Promise.resolve(this.grant(tag, 0));
    return new Promise<Permit>((resolve, reject) => {
      const w: Waiter = { tag, priority, since: Date.now(), resolve, reject };
      if (signal) {
        const onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            reject(abortError("等待容量被中止"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        w.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.waiters.push(w);
      this.pump();
    });
  }

  private grant(tag: string, waitedMs: number): Permit {
    const since = Date.now();
    // 同一个 tag 可能多份（needs 份数 > 1），用序号区分
    let key = tag;
    for (let i = 2; this.held.has(key); i++) key = `${tag}#${i}`;
    this.held.set(key, since);
    this.emit({ type: "capacity:grant", capacity: this.name, tag: key, waitedMs });
    let released = false;
    return {
      capacity: this.name,
      tag: key,
      release: () => {
        if (released) return;
        released = true;
        this.held.delete(key);
        this.emit({ type: "capacity:release", capacity: this.name, tag: key, heldMs: Date.now() - since });
        this.pump();
      },
    };
  }

  /** 门：有空位就从等待者里选——老化的压过一切 → 优先级小者先 → 等得久者先 */
  private pump(): void {
    while (this.held.size < this.limit && this.waiters.length > 0) {
      const now = Date.now();
      const aged = (w: Waiter) => (now - w.since >= this.agingMs ? 1 : 0);
      this.waiters.sort((a, b) => aged(b) - aged(a) || a.priority - b.priority || a.since - b.since);
      const w = this.waiters.shift()!;
      w.cleanup?.();
      w.resolve(this.grant(w.tag, now - w.since));
    }
  }

  stats(): { name: string; model?: string; total: number; held: number; waiting: number; heldTags: string[]; waitingTags: Array<{ tag: string; priority: Priority; waitedMs: number }> } {
    const now = Date.now();
    return {
      name: this.name,
      model: this.model ? `${this.model.provider}/${this.model.id}` : undefined,
      total: this.limit,
      held: this.held.size,
      waiting: this.waiters.length,
      heldTags: [...this.held.keys()],
      waitingTags: this.waiters.map((w) => ({ tag: w.tag, priority: w.priority, waitedMs: now - w.since })),
    };
  }
}

/** 池：只做准入限流 + 计数，不供给资源 */
export class PoolGate {
  readonly name: string;
  private limit: number;
  private active = new Map<string, number>();
  private queue: Array<{ tag: string; resolve: () => void; cleanup?: () => void }> = [];
  completed = 0;
  failed = 0;

  constructor(name: string, concurrency: number) {
    this.name = name;
    this.limit = Math.max(1, Math.floor(concurrency));
  }

  get concurrency(): number {
    return this.limit;
  }

  get running(): number {
    return this.active.size;
  }

  setConcurrency(n: number): void {
    this.limit = Math.max(1, Math.floor(n));
    this.pump();
  }

  admit(tag: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError("准入被中止"));
    if (this.active.size < this.limit && this.queue.length === 0) {
      this.active.set(tag, Date.now());
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: { tag: string; resolve: () => void; cleanup?: () => void } = { tag, resolve };
      if (signal) {
        const onAbort = () => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(abortError("准入被中止"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  release(tag: string, ok: boolean): void {
    if (!this.active.delete(tag)) return;
    if (ok) this.completed++;
    else this.failed++;
    this.pump();
  }

  private pump(): void {
    while (this.active.size < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.cleanup?.();
      this.active.set(next.tag, Date.now());
      next.resolve();
    }
  }

  stats(): { name: string; limit: number; running: number; waiting: number; completed: number; failed: number; runningTags: string[] } {
    return {
      name: this.name,
      limit: this.limit,
      running: this.active.size,
      waiting: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      runningTags: [...this.active.keys()],
    };
  }
}

/** needs 归一化：→ [{capacity, count}]，按名字排序（保证所有任务加锁顺序一致） */
export function normalizeNeeds(needs: string | string[] | Record<string, number> | undefined): Array<{ capacity: string; count: number }> {
  let list: Array<{ capacity: string; count: number }>;
  if (!needs) list = [];
  else if (typeof needs === "string") list = [{ capacity: needs, count: 1 }];
  else if (Array.isArray(needs)) list = needs.map((c) => ({ capacity: c, count: 1 }));
  else list = Object.entries(needs).map(([capacity, count]) => ({ capacity, count: Math.max(1, Math.floor(count)) }));
  const merged = new Map<string, number>();
  for (const n of list) merged.set(n.capacity, (merged.get(n.capacity) ?? 0) + n.count);
  return [...merged.entries()].map(([capacity, count]) => ({ capacity, count })).sort((a, b) => a.capacity.localeCompare(b.capacity));
}

/** 一次拿全：按名字顺序逐个拿；中途失败把已拿的全部还掉 */
export async function acquireAll(
  caps: Array<{ cap: Capacity; count: number }>,
  tag: string,
  priority: Priority,
  signal?: AbortSignal,
): Promise<Permit[]> {
  const got: Permit[] = [];
  try {
    for (const { cap, count } of caps) {
      for (let i = 0; i < count; i++) got.push(await cap.acquire(tag, priority, signal));
    }
    return got;
  } catch (e) {
    for (const p of got) p.release();
    throw e;
  }
}
