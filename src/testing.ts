/**
 * 测试 / 试用辅助：不需要任何凭证，用 pi 自带的假模型（faux）跑通整个 SDK。
 *
 *   const { runtime, faux } = await fauxRuntime();
 *   const run = await createRun({ workdir, modelRuntime: runtime });
 *   run.capacity("m", { model: "faux/m1", concurrency: 2 });
 *   faux.setResponses([fauxAssistantMessage("好的")]);
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

export async function fauxRuntime(
  opts: { provider?: string; models?: string[]; dir?: string } = {},
): Promise<{ runtime: ModelRuntime; faux: FauxProviderHandle }> {
  const provider = opts.provider ?? "faux";
  const faux = fauxProvider({ provider, models: (opts.models ?? ["m1"]).map((id) => ({ id })) });
  // 不设任何凭证，auth.json 不会被写出；dir 只是给 ModelRuntime 一个落脚点
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "agent-loom-faux-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  return { runtime, faux };
}
