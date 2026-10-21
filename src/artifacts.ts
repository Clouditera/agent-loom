/**
 * 产物登记处。规则：只要产出会驱动下游，就必须经工具或工具钩子登记，与格式无关。
 *
 * SDK 只给三样：
 *   ① 外壳：编号 / 类型 / 状态 / 来源 / 时间（+ 字段 或 文件引用）
 *   ② 两个写入口：产物工具（agent 调用）、工具钩子（write/edit 落盘自动登记）；代码里也可直接写
 *   ③ 一个查询接口：pick 选活、观测、续跑判办结 共用
 *
 * 存储：每条产物一个 JSON 文件（原子写），启动时全量载入内存索引。单进程使用。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, ArtifactSelector, ArtifactSource, FileRef, KindSpec, RunEvent } from "./types.ts";
import { ArtifactError } from "./types.ts";
import { atomicWriteJSON, ensureDir, newId, readJSON, sha256 } from "./util.ts";

const HISTORY_CAP = 50;
/** 创建序号：同一毫秒内建的多条产物也能稳定排序（只用于排序，不落盘） */
let createSeq = 0;

export interface CreateInput {
  fields?: Record<string, unknown>;
  state?: string;
  file?: FileRef;
  /** 自定义编号（同 id 已存在会报错） */
  id?: string;
}

export interface UpdateInput {
  state?: string;
  /** 浅合并进已有字段；值为 null 表示删除该字段 */
  fields?: Record<string, unknown>;
  file?: FileRef;
}

export class ArtifactStore {
  private dir: string;
  private items = new Map<string, Artifact>();
  private seq = new Map<string, number>();
  private kinds = new Map<string, KindSpec>();
  private emit: (e: RunEvent) => void;
  private onWrite: () => void;

  constructor(dir: string, emit: (e: RunEvent) => void, onWrite: () => void) {
    this.dir = dir;
    this.emit = emit;
    this.onWrite = onWrite;
    ensureDir(dir);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const a = readJSON<Artifact>(join(dir, f));
      if (a?.id) {
        this.items.set(a.id, a);
        this.seq.set(a.id, ++createSeq);
      }
    }
  }

  defineKind(kind: string, spec: KindSpec): void {
    this.kinds.set(kind, spec);
  }

  kindSpec(kind: string): KindSpec | undefined {
    return this.kinds.get(kind);
  }

  get(id: string): Artifact | undefined {
    const a = this.items.get(id);
    return a ? structuredClone(a) : undefined;
  }

  /** 唯一的读接口：按类型 + 状态（+ 附加条件）过滤，按创建时间先后 */
  query(sel: ArtifactSelector): Artifact[] {
    const states = sel.state === undefined ? undefined : new Set([sel.state].flat());
    const out: Artifact[] = [];
    for (const a of this.items.values()) {
      if (sel.kind !== "*" && a.kind !== sel.kind) continue;
      if (states && !states.has(a.state)) continue;
      if (sel.where && !sel.where(a)) continue;
      out.push(structuredClone(a));
    }
    return out.sort((x, y) => x.createdAt - y.createdAt || (this.seq.get(x.id) ?? 0) - (this.seq.get(y.id) ?? 0));
  }

  /** 观测用：类型 → 状态 → 数量 */
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const a of this.items.values()) {
      const k = (out[a.kind] ??= {});
      k[a.state] = (k[a.state] ?? 0) + 1;
    }
    return out;
  }

  create(kind: string, input: CreateInput, source: ArtifactSource): Artifact {
    if (!kind || typeof kind !== "string") throw new ArtifactError("产物类型 kind 不能为空");
    const spec = this.kinds.get(kind);
    const state = input.state ?? spec?.initial ?? "new";
    this.checkState(kind, spec, state);
    const fields = { ...(input.fields ?? {}) };
    this.checkRequired(kind, spec, fields);
    const id = input.id ?? newId(slug(kind));
    if (this.items.has(id)) throw new ArtifactError(`产物编号 ${id} 已存在；要修改请用 update`);
    const now = Date.now();
    const a: Artifact = {
      id,
      kind,
      state,
      fields,
      file: input.file,
      source,
      history: [{ at: now, state, source }],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.seq.set(id, ++createSeq);
    this.persist(a);
    this.emit({ type: "artifact:write", id, kind, state, by: source.by });
    this.onWrite();
    return structuredClone(a);
  }

  /**
   * 改状态 / 合并字段。expectState：只有当前状态在其中时才改（用于"取活后推进"的比较并交换）。
   */
  update(id: string, input: UpdateInput, source: ArtifactSource, opts: { expectState?: string | string[] } = {}): Artifact {
    const a = this.items.get(id);
    if (!a) throw new ArtifactError(`找不到产物 ${id}；可先用 query 查编号`);
    if (opts.expectState !== undefined) {
      const ok = new Set([opts.expectState].flat());
      if (!ok.has(a.state)) throw new ArtifactError(`产物 ${id} 当前状态是 ${a.state}，不是期望的 ${[...ok].join("/")}`);
    }
    const spec = this.kinds.get(a.kind);
    const prev = a.state;
    if (input.state !== undefined && input.state !== a.state) {
      this.checkState(a.kind, spec, input.state);
      const allowed = spec?.transitions?.[a.state];
      if (spec?.transitions && !(allowed ?? []).includes(input.state)) {
        throw new ArtifactError(
          `产物 ${id}（${a.kind}）不能从 ${a.state} 改到 ${input.state}；允许：${(allowed ?? []).join(", ") || "（无，终态）"}`,
        );
      }
      a.state = input.state;
    }
    if (input.fields) {
      for (const [k, v] of Object.entries(input.fields)) {
        if (v === null) delete a.fields[k];
        else a.fields[k] = v;
      }
      this.checkRequired(a.kind, spec, a.fields);
    }
    if (input.file) a.file = input.file;
    const now = Date.now();
    a.updatedAt = now;
    a.version++;
    a.history.push({ at: now, state: a.state, source });
    if (a.history.length > HISTORY_CAP) a.history.splice(0, a.history.length - HISTORY_CAP);
    this.persist(a);
    this.emit({ type: "artifact:write", id, kind: a.kind, state: a.state, prev, by: source.by });
    this.onWrite();
    return structuredClone(a);
  }

  /** 工具钩子用：同一路径只对应一条产物，重写就更新哈希与来源 */
  upsertFile(kind: string, file: FileRef, source: ArtifactSource, state?: string): Artifact {
    const id = `file:${file.path}`;
    const existing = this.items.get(id);
    if (!existing) return this.create(kind, { id, file, state, fields: {} }, source);
    if (existing.file?.sha256 === file.sha256) return structuredClone(existing);
    return this.update(id, { file, state }, source);
  }

  private persist(a: Artifact): void {
    this.items.set(a.id, a);
    atomicWriteJSON(join(this.dir, `${fileSafe(a.id)}.json`), a);
  }

  private checkState(kind: string, spec: KindSpec | undefined, state: string): void {
    if (!state || typeof state !== "string") throw new ArtifactError("状态 state 必须是非空字符串");
    if (spec?.states && !spec.states.includes(state)) {
      throw new ArtifactError(`类型 ${kind} 不允许状态 ${state}；允许：${spec.states.join(", ")}`);
    }
  }

  private checkRequired(kind: string, spec: KindSpec | undefined, fields: Record<string, unknown>): void {
    const missing = (spec?.required ?? []).filter((k) => fields[k] === undefined || fields[k] === null || fields[k] === "");
    if (missing.length) throw new ArtifactError(`类型 ${kind} 缺少必填字段：${missing.join(", ")}`);
  }
}

function slug(kind: string): string {
  return kind.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "a";
}

/** 编号 → 文件名：安全字符原样；含其它字符时替换并加哈希后缀，避免两个编号撞到同一个文件 */
function fileSafe(id: string): string {
  if (/^[a-zA-Z0-9._-]+$/.test(id)) return id;
  return `${id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)}-${sha256(id).slice(0, 10)}`;
}
