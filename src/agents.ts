/**
 * Agents: the configuration of a workflow's roles, kept apart from the roles themselves.
 *
 * A workflow declares which agents it has (their keys, and what each does by default); the caller — in Loom, the
 * platform — hands in a configuration by key. The SDK is the one place that says what that configuration is and how
 * it lands on a role; the workflow's code only names its agents.
 *
 * What a configuration does: `model` and `thinking` decide the capacity the agent's pool runs on (so the workflow
 * builds one capacity per agent), while `skills`, `extensions`, `prompts` and `tools` are added to the role the
 * agent runs. Merge order is low to high: the agent's declared defaults, then the caller's configuration.
 */
import type { AgentConfig, AgentConfigs, AgentRole, AgentSpec, AssetPath, ThinkingLevel } from "./types.ts";

/** A configuration with every field present, as the caller's values land on the agent's declared defaults. */
export interface ResolvedAgent {
	key: string;
	/** "provider/model[:thinking]" when the configuration names one (the agent gets its own capacity for it). */
	model?: AgentConfig["model"];
	thinking?: ThinkingLevel;
	skills: AssetPath[];
	extensions: NonNullable<AgentConfig["extensions"]>;
	prompts: AssetPath[];
	tools: string[];
}

export class UnknownAgentError extends Error {
	constructor(key: string, known: readonly string[]) {
		super(`没有声明名为 ${key} 的 agent${known.length ? `；已声明的：${known.join(", ")}` : "；一个都没有声明"}`);
		this.name = "UnknownAgentError";
	}
}

/**
 * 容量的模型串：模型的写法照原样留着，档位单独给容量（`CapacityOptions.thinking`）。
 * 早先档位拼在后缀里，因为容量带不动它；现在带得动了，就不再拼——也就不需要在这里认一遍档位有哪些。
 */
function withThinking(model: AgentConfig["model"], thinking: ThinkingLevel | undefined): { model: AgentConfig["model"]; thinking?: ThinkingLevel } {
	if (typeof model !== "string") return { model, thinking };
	const colon = model.lastIndexOf(":");
	// 调用方自己写了后缀就不再给档位，免得两份说法不一致
	const spelled = colon > 0 ? model.slice(colon + 1) : undefined;
	return spelled && spelled === thinking ? { model: model.slice(0, colon), thinking } : { model, thinking };
}

const merge = (low: AgentConfig | undefined, high: AgentConfig | undefined): AgentConfig => ({
	...(low?.model !== undefined || high?.model !== undefined ? { model: high?.model ?? low?.model } : {}),
	...(low?.thinking !== undefined || high?.thinking !== undefined ? { thinking: high?.thinking ?? low?.thinking } : {}),
	skills: [...(low?.skills ?? []), ...(high?.skills ?? [])],
	extensions: [...(low?.extensions ?? []), ...(high?.extensions ?? [])],
	prompts: [...(low?.prompts ?? []), ...(high?.prompts ?? [])],
	tools: [...(low?.tools ?? []), ...(high?.tools ?? [])],
});

/**
 * The agents of a run, by key: their declared defaults and the configuration the caller gave. A role is built by
 * applying the agent's configuration to it; asking for a key nobody declared is an error, so a workflow and the
 * declaration it ships with cannot drift apart without anyone noticing.
 */
export class AgentBook {
	private readonly spec: Map<string, AgentSpec>;
	private readonly given: AgentConfigs;

	constructor(specs: readonly AgentSpec[], given: AgentConfigs = {}) {
		this.spec = new Map(specs.map((s) => [s.key, s] as const));
		this.given = given;
		const unknown = Object.keys(given).filter((key) => !this.spec.has(key));
		if (unknown.length) throw new UnknownAgentError(unknown.join("、"), [...this.spec.keys()]);
	}

	/** The agent's configuration with its declared defaults filled in. */
	resolve(key: string, role?: AgentRole): ResolvedAgent {
		const spec = this.spec.get(key);
		if (!spec) throw new UnknownAgentError(key, [...this.spec.keys()]);
		const config = merge(spec.defaults, this.given[key]);
		const { model, thinking } = withThinking(config.model, config.thinking);
		return {
			key,
			...(model !== undefined ? { model } : {}),
			...(thinking !== undefined ? { thinking } : {}),
			skills: [...(config.skills ?? []), ...(role?.skills ?? [])],
			extensions: config.extensions ?? [],
			prompts: [...(config.prompts ?? []), ...(role?.prompts ?? [])],
			tools: config.tools ?? [],
		};
	}

	/** The role as the agent runs it: its own parts, plus what the configuration adds. */
	role(key: string, role: AgentRole): AgentRole {
		const resolved = this.resolve(key, role);
		return {
			...role,
			name: `${key}:${role.name}`,
			...(resolved.skills.length ? { skills: resolved.skills } : {}),
			...(resolved.extensions.length ? { extensions: [...(role.extensions ?? []), ...resolved.extensions] } : {}),
			...(resolved.prompts.length ? { prompts: resolved.prompts } : {}),
			...(resolved.tools.length ? { tools: [...(role.tools ?? []), ...resolved.tools] } : {}),
			...(resolved.thinking ? { thinking: resolved.thinking } : {}),
		};
	}

	keys(): string[] {
		return [...this.spec.keys()];
	}
}
