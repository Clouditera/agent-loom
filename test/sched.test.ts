import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireAll, Capacity, normalizeNeeds, PoolGate } from "../src/sched.ts";

const noop = () => {};

test("容量门：下游优先（优先级小者先），同级先来先得", async () => {
  const cap = new Capacity("m", { concurrency: 1 }, noop);
  const first = await cap.acquire("hold", 50);
  const order: string[] = [];
  const wait = (tag: string, prio: number) => cap.acquire(tag, prio).then((p) => { order.push(tag); return p; });
  const ws = [wait("up-a", 50), wait("down", 10), wait("mid", 30), wait("up-b", 50)];
  first.release();
  for (let i = 0; i < ws.length; i++) {
    // 每次只放一个：拿到的人立刻归还，下一个才能拿
    const granted = await Promise.race(ws.map((w, j) => w.then((p) => ({ p, j }))));
    granted.p.release();
    ws[granted.j] = new Promise(() => {});
  }
  assert.deepEqual(order, ["down", "mid", "up-a", "up-b"]);
});

test("容量门：等待超过老化阈值的压过一切优先级", async () => {
  const cap = new Capacity("m", { concurrency: 1, agingMs: 30 }, noop);
  const hold = await cap.acquire("hold", 50);
  const order: string[] = [];
  const old = cap.acquire("old-upstream", 90).then((p) => { order.push("old"); return p; });
  await new Promise((r) => setTimeout(r, 50));
  const fresh = cap.acquire("fresh-downstream", 1).then((p) => { order.push("fresh"); return p; });
  hold.release();
  (await old).release();
  (await fresh).release();
  assert.deepEqual(order, ["old", "fresh"]);
});

test("容量：归还幂等，重复 release 不会多放一个名额", async () => {
  const cap = new Capacity("m", { concurrency: 1 }, noop);
  const p = await cap.acquire("a", 50);
  p.release();
  p.release();
  const q = await cap.acquire("b", 50);
  let third = false;
  void cap.acquire("c", 50).then(() => { third = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third, false, "名额只有 1 个");
  q.release();
});

test("一次拿全：中途被中止时，已拿到的许可全部归还", async () => {
  const a = new Capacity("a", { concurrency: 1 }, noop);
  const b = new Capacity("b", { concurrency: 1 }, noop);
  const blocker = await b.acquire("blocker", 50);
  const ctl = new AbortController();
  const p = acquireAll([{ cap: a, count: 1 }, { cap: b, count: 1 }], "t", 50, ctl.signal);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(a.stats().held, 1);
  ctl.abort();
  await assert.rejects(p, /中止/);
  assert.equal(a.stats().held, 0, "a 的许可已归还");
  blocker.release();
});

test("池只限流：超过上限的排队，归还后放行", async () => {
  const g = new PoolGate("p", 2);
  await g.admit("1");
  await g.admit("2");
  let third = false;
  const t = g.admit("3").then(() => { third = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(third, false);
  g.release("1", true);
  await t;
  assert.equal(g.stats().running, 2);
  assert.equal(g.stats().completed, 1);
});

test("needs 归一化：合并同名并按名字排序（保证加锁顺序一致）", () => {
  assert.deepEqual(normalizeNeeds(["z", "a", "z"]), [{ capacity: "a", count: 1 }, { capacity: "z", count: 2 }]);
  assert.deepEqual(normalizeNeeds({ sandbox: 2, m: 1 }), [{ capacity: "m", count: 1 }, { capacity: "sandbox", count: 2 }]);
  assert.deepEqual(normalizeNeeds(undefined), []);
});
