import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { createExtensionRuntime, SettingsManager, type ExtensionAPI, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../src/index.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/testing.ts";
import { closeAll, mkRun, msgs, replies, suiteRoot, systemText, tmpDir } from "./helpers.ts";

after(() => rmSync(suiteRoot(), { recursive: true, force: true }));

const EXT_SRC = (name: string, reply: string) => `
export default function (pi) {
  pi.registerTool({
    name: "${name}", label: "${name}", description: "${name}",
    parameters: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
    execute: async (_id, p) => ({ content: [{ type: "text", text: "${reply} " + p.v }], details: {} }),
  });
}
`;
const SKILL_SRC = (name: string) => `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# ${name}\n`;

/** 在 cwd 里铺满 pi 会自动发现的东西，用来证明它们一样都没进来 */
function plantDiscoverables(cwd: string) {
  mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "prompts", "leak.md"), `---\ndescription: leak\n---\nLEAK-PROMPT $1\n`);
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extensions", "leak.js"), EXT_SRC("leak", "LEAK-TOOL"));
  mkdirSync(join(cwd, ".pi", "skills", "leak-skill-pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "skills", "leak-skill-pi", "SKILL.md"), SKILL_SRC("leak-skill-pi"));
  mkdirSync(join(cwd, ".agents", "skills", "leak-skill-agents"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "leak-skill-agents", "SKILL.md"), SKILL_SRC("leak-skill-agents"));
  writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "LEAK-APPEND");
  writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "LEAK-SYSTEM");
  writeFileSync(join(cwd, "AGENTS.md"), "LEAK-AGENTS-MD");
}

test("自动发现全关：cwd 的 .pi / .agents / AGENTS.md / APPEND_SYSTEM.md 和宿主机 ~/.agents/skills 都不进来", async () => {
  const { run, faux, cwd } = await mkRun("no-discovery");
  plantDiscoverables(cwd);
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  // 开 read（skills 只在有读文件工具时才列出）和 leak（若扩展被发现，这个工具就会存在）
  const s = await run.session("s", { name: "r", system: "ROLE-SYS", tools: ["read", "leak"] });
  let ctx1: any;
  let ctx2: any;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("leak", { v: "x" })], { stopReason: "toolUse" }),
    (c: any) => ((ctx1 = c), fauxAssistantMessage("ok")),
    (c: any) => ((ctx2 = c), fauxAssistantMessage("ok")),
  ]);
  await p.run(s, "go", { outputHint: false });
  const sys = systemText(ctx1);
  assert.match(sys, /ROLE-SYS/);
  for (const leak of ["LEAK-AGENTS-MD", "LEAK-APPEND", "LEAK-SYSTEM", "leak-skill-pi", "leak-skill-agents", "<available_skills>"]) {
    assert.ok(!sys.includes(leak), `不该出现 ${leak}：\n${sys}`);
  }
  assert.ok(msgs(ctx1).some((m) => /toolResult:Tool leak not found/.test(m)), "cwd/.pi/extensions 不该被加载");
  await p.run(s, "/leak abc", { outputHint: false });
  assert.equal(msgs(ctx2).at(-1), "user:/leak abc", "cwd/.pi/prompts 不该被加载");
  await closeAll(run);
});

test("声明资产：skills / extensions（文件 + 内联工厂）/ prompts / context 都生效，和 cwd 里的同类东西互不混", async () => {
  const { run, faux, cwd } = await mkRun("declared");
  plantDiscoverables(cwd);
  const assets = tmpDir("assets");
  mkdirSync(join(assets, "skills", "pdf-tools"), { recursive: true });
  writeFileSync(join(assets, "skills", "pdf-tools", "SKILL.md"), SKILL_SRC("pdf-tools"));
  writeFileSync(join(assets, "greet.js"), EXT_SRC("greet", "你好"));
  mkdirSync(join(assets, "prompts"), { recursive: true });
  writeFileSync(join(assets, "prompts", "review.md"), `---\ndescription: 审阅\n---\n审阅这些改动，重点看 \${1:-正确性}。\n`);
  writeFileSync(join(assets, "RULES.md"), "DECLARED-CONTEXT-FILE");

  const role: AgentRole = {
    name: "full",
    system: "SYS-FULL",
    skills: [join(assets, "skills")],
    extensions: [
      pathToFileURL(join(assets, "greet.js")), // file: URL 也行
      (api: ExtensionAPI) =>
        api.registerTool({
          name: "stamp",
          label: "stamp",
          description: "stamp",
          parameters: Type.Object({ v: Type.String() }),
          execute: async (_id, p) => ({ content: [{ type: "text", text: `已盖章 ${p.v}` }], details: {} }),
        }),
    ],
    prompts: [join(assets, "prompts")],
    context: [join(assets, "RULES.md"), { name: "inline-rules", content: "DECLARED-INLINE-CONTEXT" }],
    tools: ["read", "greet", "stamp"],
  };
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  const s = await run.session("full", role);
  let ctx1: any;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("greet", { v: "世界" }), fauxToolCall("stamp", { v: "42" })], { stopReason: "toolUse" }),
    (c: any) => ((ctx1 = c), fauxAssistantMessage("ok")),
  ]);
  await p.run(s, "go", { outputHint: false });
  const sys = systemText(ctx1);
  assert.match(sys, /SYS-FULL/);
  assert.match(sys, /pdf-tools/, "声明的 skill 进了系统提示词");
  assert.ok(!sys.includes("leak-skill"), "cwd 的 skill 没混进来");
  assert.match(sys, /DECLARED-CONTEXT-FILE/, "声明的上下文文件进了系统提示词");
  assert.match(sys, /DECLARED-INLINE-CONTEXT/, "内联上下文进了系统提示词");
  assert.ok(!sys.includes("LEAK-AGENTS-MD"), "cwd 的 AGENTS.md 没混进来");
  const results = msgs(ctx1).filter((m) => m.startsWith("toolResult:"));
  assert.ok(results.some((m) => /你好 世界/.test(m)), `扩展文件的工具执行了：${results}`);
  assert.ok(results.some((m) => /已盖章 42/.test(m)), `内联扩展的工具执行了：${results}`);

  let ctx2: any;
  faux.setResponses([(c: any) => ((ctx2 = c), fauxAssistantMessage("ok"))]);
  await p.run(s, "/review 性能", { outputHint: false });
  assert.match(msgs(ctx2).at(-1)!, /审阅这些改动，重点看 性能/, "声明的模板会展开");
  await closeAll(run);
});

test("声明的资产路径不存在：建 agent 时直接报错，指出是哪个", async () => {
  const { run, faux } = await mkRun("missing-asset");
  faux.setResponses(replies(2));
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  const s1 = await run.session("a", { name: "r", system: "S", skills: ["/nope/skills"] });
  await assert.rejects(() => p.run(s1, "x"), /资产加载失败[\s\S]*\/nope\/skills/);
  const s2 = await run.session("b", { name: "r", system: "S", context: ["/nope/RULES.md"] });
  await assert.rejects(() => p.run(s2, "x"), /上下文文件不存在：\/nope\/RULES\.md/);
  await closeAll(run);
});

test("不能在 pi 里指定：SDK 接管项、自动发现开关、资产路径（各给出改法）", async () => {
  const { run, faux } = await mkRun("managed");
  const bad = (pi: unknown) => run.session(`m-${Math.random()}`, { name: "r", system: "S", pi: pi as never });
  await assert.rejects(() => bad({ sessionManager: {}, modelRuntime: {} }), /pi\.sessionManager \/ pi\.modelRuntime 由 SDK 接管/);
  await assert.rejects(() => bad({ noSkills: false }), /pi\.noSkills 不能指定 —— 自动发现由 SDK 固定全关/);
  await assert.rejects(() => bad({ additionalSkillPaths: ["x"], extensionFactories: [] }), /pi\.additionalSkillPaths 请改用 role\.skills；pi\.extensionFactories 请改用 role\.extensions/);
  // 工厂返回的在建 agent 时检查
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  faux.setResponses(replies(3));
  const s = await run.session("m2", { name: "r", system: "S", pi: () => ({ model: {} }) as never });
  await assert.rejects(() => p.run(s, "x"), /pi\.model 由 SDK 接管/);
  await closeAll(run);
});

test("pi 直通：工厂按模型 / 会话名决定；systemPrompt 作基础、role.system 追加在后", async () => {
  const { run, faux } = await mkRun("factory");
  const seen: string[] = [];
  const role: AgentRole = {
    name: "f",
    system: "ROLE-SYS",
    pi: ({ model, sessionName }) => {
      seen.push(`${model.provider}/${model.id}@${sessionName}`);
      return { systemPrompt: "PI-BASE", appendSystemPrompt: ["PI-APPEND"], settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) };
    },
  };
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  let ctx: any;
  faux.setResponses([(c: any) => ((ctx = c), fauxAssistantMessage("ok"))]);
  await p.run(await run.session("named", role), "go");
  assert.deepEqual(seen, ["faux/m1@named"]);
  const sys = systemText(ctx);
  const [a, b, c] = ["PI-BASE", "PI-APPEND", "ROLE-SYS"].map((t) => sys.indexOf(t));
  assert.ok(a >= 0 && b > a && c > b, sys);
  await closeAll(run);
});

test("自带 resourceLoader：原样使用、role.system 追加在后；同时在角色上声明资产会报错", async () => {
  const { run, faux } = await mkRun("own-loader");
  const loader: ResourceLoader = {
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
  const p = run.pool("p", { needs: "m", concurrency: 1 });
  let ctx: any;
  faux.setResponses([(c: any) => ((ctx = c), fauxAssistantMessage("ok"))]);
  await p.run(await run.session("own", { name: "o", system: "ROLE-SYS", pi: { resourceLoader: loader } }), "go");
  assert.match(systemText(ctx), /BASE-PROMPT[\s\S]*BASE-APPEND[\s\S]*ROLE-SYS/);

  faux.setResponses(replies(1));
  const s = await run.session("own2", { name: "o", system: "S", skills: ["/x"], pi: { resourceLoader: loader } });
  await assert.rejects(() => p.run(s, "go"), /自带 pi\.resourceLoader 时，skills 请在你的加载器里提供/);
  await closeAll(run);
});
