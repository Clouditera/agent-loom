import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createExtensionRuntime, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../src/index.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/testing.ts";
import { closeAll, mkRun, msgs, replies, suiteRoot, systemText, tmpDir } from "./helpers.ts";

after(() => rmSync(suiteRoot(), { recursive: true, force: true }));

test("直通 pi：扩展注册的自定义工具可用、skills 进系统提示词、提示词模板能展开", async () => {
  const { run, faux } = await mkRun("passthrough");
  const extDir = tmpDir("ext");
  writeFileSync(
    join(extDir, "index.ts"),
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "greet", label: "greet", description: "say hi",
    parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] } as any,
    execute: async (_id: string, p: any) => ({ content: [{ type: "text" as const, text: "你好 " + p.who }], details: {} }),
  });
}
`,
  );
  const skillDir = tmpDir("skill");
  mkdirSync(join(skillDir, "pdf-tools"), { recursive: true });
  writeFileSync(
    join(skillDir, "pdf-tools", "SKILL.md"),
    `---\nname: pdf-tools\ndescription: 处理 PDF 文件时使用\n---\n\n# PDF tools\n\n读 references/formats.md。\n`,
  );
  const promptDir = tmpDir("prompts");
  writeFileSync(join(promptDir, "review.md"), `---\ndescription: 审阅改动\n---\n审阅这些改动，重点看 \${1:-正确性}。\n`);

  const role: AgentRole = {
    name: "full",
    system: "SYS-FULL",
    pi: {
      // 关掉宿主机上的默认发现，结果可重复；额外路径照常生效
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      // 注意：tools 一旦给了就是白名单，扩展 / 自定义工具都得写进来
      // 另外 skills 只有在有"能读文件"的工具（如 read）时才会列进系统提示词
      tools: ["read", "greet"],
      additionalExtensionPaths: [extDir],
      additionalSkillPaths: [skillDir],
      additionalPromptTemplatePaths: [promptDir],
    },
  };
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  const s = await run.session("full", role);

  let ctx1: any;
  let toolResult = "";
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("greet", { who: "世界" })], { stopReason: "toolUse" }),
    (ctx: any) => ((ctx1 = ctx), (toolResult = msgs(ctx).filter((m) => m.startsWith("toolResult:")).at(-1)!), fauxAssistantMessage("ok")),
  ]);
  await p.run(s, "go", { outputHint: false });
  assert.ok(s.contextUsage() !== undefined);
  assert.match(systemText(ctx1), /SYS-FULL/, "角色的 system 生效");
  assert.match(systemText(ctx1), /pdf-tools/, "skills 进了系统提示词");
  assert.match(toolResult, /你好 世界/, "扩展注册的工具真的执行了");

  // 提示词模板：发 /review 会被展开
  let ctx2: any;
  faux.setResponses([(ctx: any) => ((ctx2 = ctx), fauxAssistantMessage("ok"))]);
  await p.run(s, "/review 性能");
  assert.match(msgs(ctx2).at(-1)!, /审阅这些改动，重点看 性能/, "模板展开成实际提示词");
  await closeAll(run);
});

test("SDK 接管的选项：角色在 pi 里指定会直接报错（对象在开会话时、工厂在建 agent 时）", async () => {
  const { run, faux } = await mkRun("managed");
  await assert.rejects(
    () => run.session("m1", { name: "r", system: "S", pi: { sessionManager: {}, modelRuntime: {} } as never }),
    /pi\.sessionManager \/ pi\.modelRuntime 由 SDK 接管/,
  );
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  faux.setResponses(replies(3));
  const s = await run.session("m2", { name: "r", system: "S", pi: () => ({ model: {} }) as never });
  await assert.rejects(() => p.run(s, "x"), /pi\.model 由 SDK 接管/);
  await closeAll(run);
});

test("pi 选项可以是工厂：按当前模型和会话名决定；自带的资源加载器保持原样，角色的 system 追加在后", async () => {
  const { run, faux } = await mkRun("factory");
  const seen: Array<{ model: string; session: string }> = [];
  const base: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "BASE-PROMPT",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => ["BASE-APPEND"],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const role: AgentRole = {
    name: "f",
    system: "ROLE-SYSTEM",
    pi: (ctx) => {
      seen.push({ model: `${ctx.model.provider}/${ctx.model.id}`, session: ctx.sessionName });
      return { resourceLoader: base, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) };
    },
  };
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  let ctx: any;
  faux.setResponses([(c: any) => ((ctx = c), fauxAssistantMessage("ok"))]);
  await p.run(await run.session("named", role), "go");
  assert.deepEqual(seen, [{ model: "faux/m1", session: "named" }]);
  assert.match(systemText(ctx), /BASE-PROMPT/);
  assert.match(systemText(ctx), /BASE-APPEND/);
  assert.match(systemText(ctx), /ROLE-SYSTEM/);
  await closeAll(run);
});

test("不给 pi 选项时用默认资源发现：cwd 下的 prompts 模板能找到（宿主机自己的 skills 关掉以保证可重复）", async () => {
  const { run, faux, cwd } = await mkRun("default-discovery");
  mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "prompts", "check.md"), `---\ndescription: 检查\n---\n检查 \${1:-全部}。\n`);
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  let ctx: any;
  faux.setResponses([(c: any) => ((ctx = c), fauxAssistantMessage("ok"))]);
  await p.run(await run.session("d", { name: "d", system: "S", pi: { noSkills: true, noExtensions: true } }), "/check 并发");
  assert.match(msgs(ctx).at(-1)!, /检查 并发/);
  await closeAll(run);
});

test("pi.systemPrompt 作基础、role.system 追加在后；extensionFactories 内联扩展的工具可用", async () => {
  const { run, faux } = await mkRun("inline-ext");
  const role: AgentRole = {
    name: "inline",
    system: "ROLE-SYS",
    pi: {
      systemPrompt: "PI-BASE",
      appendSystemPrompt: ["PI-APPEND"],
      noSkills: true,
      noExtensions: true,
      noContextFiles: true,
      tools: ["stamp"],
      extensionFactories: [
        (api) =>
          api.registerTool({
            name: "stamp",
            label: "stamp",
            description: "stamp a value",
            parameters: Type.Object({ v: Type.String() }),
            execute: async (_id, p) => ({ content: [{ type: "text", text: `已盖章 ${p.v}` }], details: {} }),
          }),
      ],
    },
  };
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  let ctx: any;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("stamp", { v: "42" })], { stopReason: "toolUse" }),
    (c: any) => ((ctx = c), fauxAssistantMessage("ok")),
  ]);
  await p.run(await run.session("i", role), "go", { outputHint: false });
  const sys = systemText(ctx);
  assert.ok(sys.indexOf("PI-BASE") >= 0 && sys.indexOf("PI-APPEND") > sys.indexOf("PI-BASE") && sys.indexOf("ROLE-SYS") > sys.indexOf("PI-APPEND"), sys);
  assert.ok(msgs(ctx).some((m) => /toolResult:已盖章 42/.test(m)), msgs(ctx).join("\n"));
  await closeAll(run);
});
