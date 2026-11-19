import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../src/index.ts";

/**
 * 思考档位：某一档能不能用由 pi 按模型配置判断（`getSupportedThinkingLevels`），SDK 不维护名单；
 * 给模型对象时档位从 `CapacityOptions.thinking` 进，不从字符串里拆。
 *
 * 这里不用 faux provider：它造出来的模型没有 `thinkingLevelMap`，表达不了「这个模型支持哪些档位」。
 */

type Model = { id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> };

/** 只认几张模型的 runtime：`getModel` / `getModels` 是 `resolveModel` 要的全部。 */
function runtimeWith(models: Model[]) {
  const of = (provider: string, id: string) => (provider === "p" ? models.find((m) => m.id === id) : undefined);
  return {
    getModel: (provider: string, id: string) => of(provider, id),
    getModels: (provider: string) => (provider === "p" ? models : []),
  } as never;
}

async function makeRun(models: Model[]) {
  const dir = mkdtempSync(join(tmpdir(), "agent-loom-capacity-"));
  return createRun({ workdir: join(dir, "run"), modelRuntime: runtimeWith(models), quietMs: 50, pollMs: 20 });
}

test("档位由模型配置判断：写了 max 的模型认 max", async () => {
  const run = await makeRun([{ id: "m1", reasoning: true, thinkingLevelMap: { max: "max", high: "high" } }]);
  const cap = run.capacity("m", { model: "p/m1:max", concurrency: 1 });
  assert.equal(cap.thinking, "max");
  await run.close();
});

test("模型配置里没写的档位不拆：那一段算模型名的一部分", async () => {
  const run = await makeRun([{ id: "m1", reasoning: true, thinkingLevelMap: { high: "high" } }]);
  // m1 不支持 max：整串当成模型名去找，找不到就报错，不会静默降成别的档
  assert.throws(() => run.capacity("m", { model: "p/m1:max", concurrency: 1 }), /找不到模型/);
  await run.close();
});

test("模型名自带冒号不被误拆（p/llama3:8b）", async () => {
  const run = await makeRun([{ id: "llama3:8b", reasoning: true, thinkingLevelMap: { high: "high" } }]);
  const cap = run.capacity("m", { model: "p/llama3:8b", concurrency: 1 });
  assert.equal(cap.thinking, undefined);
  assert.equal((cap.model as Model | undefined)?.id, "llama3:8b");
  await run.close();
});

test("给模型对象时，档位从 CapacityOptions.thinking 进", async () => {
  const models: Model[] = [{ id: "m1", reasoning: true, thinkingLevelMap: { max: "max" } }];
  const run = await makeRun(models);
  const cap = run.capacity("m", { model: models[0] as never, thinking: "max", concurrency: 1 });
  assert.equal(cap.thinking, "max");
  await run.close();
});
