/**
 * model-config-status.ts — 平台模型配置页的「全配置点状态」读取（0.6，2026-11-16）
 *
 * 派单：[team] msg_afdb04ed17da47a2（GET 读全部配置点状态）。
 * 区块：飞轮 6 模块（共用 mind.env）/ 平台 3 env / Agent fleet 7 台 / 相关视图。
 *
 * 硬约束：
 *   1) key 只回尾号（maskValue），明文绝不进返回体、不进日志；
 *   2) mtimeFresh = 配置 mtime 与进程启动时刻比对（历史坑：改了不重启不生效）；
 *   3) 读不到一律 n/a + 原因，不编造、不写 0 冒充。
 *
 * 设计基线：[internal-doc]
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { Pool } from "pg";
import { MODEL_KEYS, maskValue, parseEnvText } from "./model-config";

export interface ConfigPoint {
  id: string;
  name: string;
  group: string;
  model?: string;
  baseUrl?: string;
  keyTail?: string;
  unit?: string;
  unitActive?: boolean;
  startedAt?: string;
  configMtime?: string;
  mtimeFresh?: boolean;
  locked?: boolean;
  lockReason?: string;
  unavailable?: string;
  /** 区块 C 专有：agent 所在机器（取不到 -> machineNote 给原因） */
  machine?: string;
  machineNote?: string;
  /** 区块 C 专有：brain 类型（dsh 执行体 / hermes 网关 / openclaw 网关） */
  brain?: string;
  /** 区块 C 专有：当前 provider（从 brain 配置反查，查不到 -> 页面 n/a） */
  provider?: string;
  /** 区块 C 专有：主 provider 之外的降级通道（openclaw fallbacks / hermes fallback_providers） */
  fallback?: string;
  /** 该点是否可直连测试调用（走网关链路的 agent 点为 false，按钮 disabled） */
  testable?: boolean;
  /** 承载该点的配置文件（confirm 弹窗复述目标文件用；不含任何值） */
  envFile?: string;
  /** 没有单元状态的原因（如按需触发、无常驻单元）；与 unavailable 区分：本点数据是有的 */
  unitNote?: string;
}

export interface ConfigGroup { id: string; title: string; envFile?: string; points: ConfigPoint[] }

const HOME = os.homedir();

/** 只读执行（只跑只读 systemctl 查询；失败返回空，不抛——状态读不到时页面显示 n/a）。 */
function ro(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * 单元状态查询缓存（TTL 15s）。
 * 不加缓存时一次 GET 要起约 30 个 systemctl 进程（飞轮 6 点共用同一个 unit 却各查两遍），
 * 3107 实测把接口拖到 2.5–14s；缓存后同一 unit 每 15s 最多查一次，页面 60s 轮询完全够用。
 */
const unitCache = new Map<string, { at: number; active?: boolean; startedAt?: string }>();
const UNIT_TTL_MS = 15000;

function unitInfo(unit: string): { active?: boolean; startedAt?: string } {
  if (!unit) return {};
  const hit = unitCache.get(unit);
  if (hit && Date.now() - hit.at < UNIT_TTL_MS) return { active: hit.active, startedAt: hit.startedAt };
  const active = ro("systemctl", ["--user", "is-active", unit]);
  // 2026-11-16 修：原用 --value 拿 "Mon 2026-11-16 20:15:19 CST" 字符串，new Date() 会把它当 UTC-6
  //   -> startedAt 比真实晚 14h -> mtimeFresh 假绿（真实重启后 14h 内的改动都判「已生效」）。
  //   改用 --timestamp=unix 取 epoch（@1794831319），转 ISO，无时区解析歧义。
  const startedEpoch = ro("systemctl", ["--user", "show", unit, "-p", "ExecMainStartTimestamp", "--timestamp=unix", "--value"]);
  const mEpoch = startedEpoch && /^@\d+$/.test(startedEpoch.trim()) ? parseInt(startedEpoch.trim().slice(1), 10) : NaN;
  const startedAt = Number.isFinite(mEpoch) ? new Date(mEpoch * 1000).toISOString() : undefined;
  const val = { active: active === "active", startedAt };
  unitCache.set(unit, { at: Date.now(), ...val });
  return val;
}

/** mtimeFresh：配置文件 mtime 是否早于进程启动（true=已生效；false=改了没重启）。 */
function freshness(file: string, startedAt?: string): boolean | undefined {
  if (!file || !startedAt || !fs.existsSync(file)) return undefined;
  try {
    const m = fs.statSync(file).mtime;
    const s = new Date(startedAt);
    if (Number.isNaN(s.getTime())) return undefined;
    // 2026-11-16 判据③（运营团队/platform-data）：**同秒相等**（|delta| < 1s）不得默认「已生效」或「未生效」，
    //   必须返回 undefined（页面显示 n-a + 原因）—— 因为 mtime 与进程启动时刻同秒时，无法判断配置是否在启动前落地。
    const delta = m.getTime() - s.getTime();
    if (Math.abs(delta) < 1000) return undefined;
    return delta <= 0;
  } catch {
    return undefined;
  }
}

function stamp(t: Date): string {
  return t.toISOString().replace("T", " ").slice(0, 19);
}

function envPoint(opts: {
  id: string; name: string; group: string; file: string; unit?: string; unitNote?: string;
  locked?: boolean; lockReason?: string;
}): ConfigPoint {
  const { id, name, group, file, unit, unitNote, locked, lockReason } = opts;
  const base: ConfigPoint = { id, name, group, locked, lockReason, testable: true, envFile: file, unitNote };
  if (!fs.existsSync(file)) {
    return { ...base, unavailable: "配置文件不存在（" + file + "）" };
  }
  try {
    const env = parseEnvText(fs.readFileSync(file, "utf8"));
    const mtime = stamp(fs.statSync(file).mtime);
    const u = unit ? unitInfo(unit) : {};
    return {
      ...base,
      model: env.ANTHROPIC_MODEL || undefined,
      baseUrl: env.ANTHROPIC_BASE_URL || undefined,
      keyTail: env.ANTHROPIC_AUTH_TOKEN ? maskValue(env.ANTHROPIC_AUTH_TOKEN) : undefined,
      unit,
      unitActive: u.active,
      startedAt: u.startedAt,
      configMtime: mtime,
      mtimeFresh: freshness(file, u.startedAt),
    };
  } catch (e) {
    return { ...base, unavailable: "配置读取失败：" + String((e as Error)?.message || e).slice(0, 80) };
  }
}

/** 飞轮 6 模块：共用 ~/.config/lions/mind.env（lions-mind.service:66 EnvironmentFile）。 */
function flywheelGroup(): ConfigGroup {
  const file = path.join(HOME, ".config", "lions", "mind.env");
  const modules: Array<[string, string]> = [
    ["reflect", "反思 reflect"],
    ["structure", "结构化 structure"],
    ["improving-tasks", "改进任务 improving-tasks"],
    ["global-organizer", "全局组织 global-organizer"],
    ["cognitive-extractor", "认知提取 cognitive-extractor"],
    ["shorten-title", "标题生成 shorten-title"],
  ];
  return {
    id: "flywheel",
    title: "飞轮模型（6 模块共用一份配置）",
    envFile: file,
    points: modules.map(([id, name]) => envPoint({ id: "fw-" + id, name, group: "flywheel", file, unit: "lions-mind.service" })),
  };
}

/** 平台 3 env：session 提取 / sales-mind / selfimproving（后者锁定）。 */
function platformGroup(): ConfigGroup {
  const dir = path.join(HOME, ".config", "lions");
  // 单元按实配置（2026-11-16 逐个 systemctl 复核，不编造）：
  //   sales-mind -> lions-sales-mind.service（实测 inactive，页面如实显示未运行）
  //   selfimproving -> lions-selfimproving.service（实测 active）
  //   session-extract -> 定时器按需触发、无常驻进程，**不挂单元**，改给 unitNote 说明原因
  const defs: Array<{ id: string; name: string; file: string; unit?: string; unitNote?: string; locked?: boolean; reason?: string }> = [
    {
      id: "session-extract",
      name: "会话提取 session-extract",
      file: path.join(dir, "session-extract-model.env"),
      unitNote: "按需触发（定时器调度），无常驻单元",
    },
    { id: "sales-mind", name: "销售 mind sales-mind", file: path.join(dir, "sales-mind-model.env"), unit: "lions-sales-mind.service" },
    {
      id: "selfimproving",
      name: "自我改进 selfimproving",
      file: path.join(dir, "selfimproving-llm.env"),
      unit: "lions-selfimproving.service",
      locked: true,
      reason: "用户指示暂不切（2026-11-16）",
    },
  ];
  return {
    id: "platform",
    title: "平台其他模型",
    points: defs.map((d) => envPoint({ id: d.id, name: d.name, group: "platform", file: d.file, unit: d.unit, unitNote: d.unitNote, locked: d.locked, lockReason: d.reason })),
  };
}

// ── 区块 C：Agent 模型（7 台，本机直读 brain/provider/model） ─────────────────
//
// 口径来源 docs/platform-logic/MODEL-PROVIDERS.md §一（2026-09-24 确认，逐条有复算命令）：
//   agent-d      -> DSH 执行体（headless profile 的 agent-default-model）
//   agent-e/agent-c/agent-f/agent-i -> hermes 网关（~/.hermes/config.yaml）
//   agent-b/operator -> openclaw 网关（~/.openclaw/openclaw.json）
// 本机（101）只承载 3 个 responder 单元（agent-d/agent-e/operator）；
// 其余 4 台的「机器/单元状态」需 devops 采集文件，缺 -> n/a + 原因（不编造）。

interface BrainCfg { provider?: string; model?: string; fallback?: string; reason?: string }

/** DSH 执行体默认模型：~/.dsh/profiles/headless/cordis.patch.yml 的 - id: agent-default-model。 */
function dshBrain(): BrainCfg {
  const file = path.join(HOME, ".dsh", "profiles", "headless", "cordis.patch.yml");
  if (!fs.existsSync(file)) return { reason: "dsh headless 配置不存在" };
  try {
    const text = fs.readFileSync(file, "utf8");
    const at = text.indexOf("- id: agent-default-model");
    if (at < 0) return { reason: "dsh headless 未声明默认模型" };
    const seg = text.slice(at, at + 500);
    const provider = /^\s*provider:\s*(\S+)\s*$/m.exec(seg)?.[1];
    const model = /^\s*model:\s*(\S+)\s*$/m.exec(seg)?.[1];
    if (!provider && !model) return { reason: "dsh 默认模型未配置 provider/model" };
    return { provider, model };
  } catch (e) {
    return { reason: "dsh 配置读取失败：" + String((e as Error)?.message || e).slice(0, 60) };
  }
}

/** hermes 网关默认模型：顶层 model + 在 providers 里反查归属（多归属或查不到 -> n/a 原因）。 */
function hermesBrain(): BrainCfg {
  const file = path.join(HOME, ".hermes", "config.yaml");
  if (!fs.existsSync(file)) return { reason: "hermes 配置不存在" };
  try {
    const text = fs.readFileSync(file, "utf8");
    const model = /^model:\s*(\S+)\s*$/m.exec(text)?.[1];
    if (!model) return { reason: "hermes 未声明默认模型" };
    const providers = parseHermesProviders(text);
    const hits = providers.filter((p) => p.models.includes(model)).map((p) => p.id);
    const fb = /^\s*-\s*provider:\s*(\S+)\s*$/m.exec(
      (text.split("fallback_providers:")[1] || "").split("\n").slice(0, 6).join("\n")
    )?.[1];
    if (hits.length === 1) return { provider: hits[0], model, fallback: fb };
    if (hits.length > 1) return { model, fallback: fb, reason: "模型同时登记在 " + hits.join(" / ") + "，归属需人工指定" };
    return { model, fallback: fb, reason: "providers 未登记该模型（需人工指定 provider）" };
  } catch (e) {
    return { reason: "hermes 配置读取失败：" + String((e as Error)?.message || e).slice(0, 60) };
  }
}

/** openclaw 网关默认模型：agents.entries.main.model.primary = "provider/model"。 */
function openclawBrain(): BrainCfg {
  const file = path.join(HOME, ".openclaw", "openclaw.json");
  if (!fs.existsSync(file)) return { reason: "openclaw 配置不存在" };
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as OpenClawCfg;
    const e = cfg.agents?.entries?.main;
    const primary = e?.model?.primary;
    const fb = e?.model?.fallbacks || [];
    if (!primary) return { reason: "openclaw main 未声明模型" };
    const at = primary.indexOf("/");
    return {
      provider: at > 0 ? primary.slice(0, at) : undefined,
      model: at > 0 ? primary.slice(at + 1) : primary,
      fallback: fb.length ? fb.join(", ") : undefined,
    };
  } catch (e) {
    return { reason: "openclaw 配置读取失败：" + String((e as Error)?.message || e).slice(0, 60) };
  }
}

interface AgentDef {
  id: string;
  brain: "dsh" | "hermes" | "openclaw";
  /** 本机（101）承载的 responder 单元；没有 = 远程机器，需 devops 采集 */
  unit?: string;
}

const BRAIN_LABEL: Record<AgentDef["brain"], string> = {
  dsh: "DSH 执行体",
  hermes: "hermes 网关",
  openclaw: "openclaw 网关",
};

const AGENTS: AgentDef[] = [
  { id: "agent-d", brain: "dsh", unit: "macs-responder-agent-d.service" },
  { id: "agent-e", brain: "hermes", unit: "macs-responder-agent-e.service" },
  { id: "operator", brain: "openclaw", unit: "macs-responder-operator.service" },
  { id: "agent-b", brain: "openclaw" },
  { id: "agent-c", brain: "hermes" },
  { id: "agent-f", brain: "hermes" },
  { id: "agent-i", brain: "hermes" },
];

/**
 * devops 采集文件（远程机器 100/104 的机器列与单元状态）。
 * 约定路径 ~/.config/lions/fleet-model-snapshot.json（可用 LIONS_FLEET_SNAPSHOT 覆盖），
 * 结构：{ "asOf": "ISO", "agents": { "<agentId>": { "machine": "100", "unitActive": true, "startedAt": "..." } } }
 * 文件不存在 = devops 通道未就绪 -> n/a + 「等 devops ssh 通道（已派单）」，**不编造**。
 */
interface Snapshot { asOf?: string; agents?: Record<string, { machine?: string; unitActive?: boolean; startedAt?: string }> }

function readSnapshot(): { snap?: Snapshot; reason: string } {
  // 固定约定路径（不设环境变量开关：AGENTS.md §七 未登记开关视为不存在）。
  const file = path.join(HOME, ".config", "lions", "fleet-model-snapshot.json");
  if (!fs.existsSync(file)) return { reason: "等 devops ssh 通道（已派单）" };
  try {
    return { snap: JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot, reason: "" };
  } catch (e) {
    return { reason: "采集文件解析失败：" + String((e as Error)?.message || e).slice(0, 60) };
  }
}

function fleetGroup(): ConfigGroup {
  const { snap, reason } = readSnapshot();
  const brains: Record<string, BrainCfg> = { dsh: dshBrain(), hermes: hermesBrain(), openclaw: openclawBrain() };
  const points: ConfigPoint[] = AGENTS.map((a) => {
    const brain = brains[a.brain];
    const remote = snap?.agents?.[a.id];
    const machine = remote?.machine || (a.unit ? "101（本机）" : undefined);
    const u = a.unit ? unitInfo(a.unit) : {}; // 每台只查一次（原先查两遍，耗时翻倍）
    const base: ConfigPoint = {
      id: a.id,
      name: "智能体 " + a.id,
      group: "fleet",
      brain: BRAIN_LABEL[a.brain],
      provider: brain.provider,
      model: brain.model,
      fallback: brain.fallback,
      testable: false, // 智能体走网关/执行体链路，无直连凭据，不提供直连测试
      machine,
      machineNote: machine ? undefined : reason,
      unit: a.unit || remote?.unitActive !== undefined ? "macs-responder-" + a.id + ".service" : undefined,
      unitActive: a.unit ? u.active : remote?.unitActive,
      startedAt: a.unit ? u.startedAt : remote?.startedAt,
    };
    if (brain.reason && !brain.provider && !brain.model) {
      return { ...base, unavailable: brain.reason };
    }
    return base;
  });
  return { id: "fleet", title: "智能体模型", points };
}

export function readAllGroups(): ConfigGroup[] {
  return [flywheelGroup(), platformGroup(), fleetGroup()];
}

/**
 * 配置点 -> 承载它的配置文件（test-call 用它读明文 key；fleet 的 agent 点无 ANTHROPIC 键，返回空）。
 *
 * ⚠️ **覆盖范围（2026-11-16 运营团队口径缺口登记）**：
 *   ✅ 覆盖：flywheel → ~/.config/lions/mind.env；
 *            platform → session-extract-model.env / sales-mind-model.env / selfimproving-llm.env（共 4 个 .env）
 *   ❌ **不覆盖**：
 *      · systemd drop-in（如 ~/.config/systemd/user/lions-mind.service.d/*.conf）——
 *        改了 drop-in 但没 daemon-reload/重启时，本页**无法提示「未生效」**（mtimeFresh 只看 .env 的 mtime）
 *      · hermes-gateway env（其它进程的 env 文件）
 *      · fleet 的 agent 点（无 ANTHROPIC 键，返回 undefined 是**预期**，非缺陷）
 *   → 页面/文档对上述缺口**不承诺覆盖**；扩展需另立项（drop-in glob + daemon-reload 时效判定）。
 */
export function fileForPoint(p: ConfigPoint): string | undefined {
  const dir = path.join(HOME, ".config", "lions");
  if (p.group === "flywheel") return path.join(dir, "mind.env");
  if (p.group === "platform") {
    if (p.id === "session-extract") return path.join(dir, "session-extract-model.env");
    if (p.id === "sales-mind") return path.join(dir, "sales-mind-model.env");
    if (p.id === "selfimproving") return path.join(dir, "selfimproving-llm.env");
  }
  return undefined;
}

/** 从配置文件读明文 key（**只在服务端内存中用，不进返回体、不进日志**；用完即弃）。 */
export async function testCall(point: ConfigPoint, prompt: string, file?: string): Promise<{ httpStatus?: number; ok?: boolean; replyFirst20?: string; error?: string }> {
  if (!point || point.unavailable) return { error: point?.unavailable || "配置点不可用" };
  if (!point.baseUrl) return { error: "该配置点无模型地址，无法测试调用" };
  // 明文 key 只在这里从文件读入内存，用完即弃：不进返回体、不进日志、不写任何文件。
  let apiKey = "";
  if (file && fs.existsSync(file)) {
    try { apiKey = parseEnvText(fs.readFileSync(file, "utf8")).ANTHROPIC_AUTH_TOKEN || ""; } catch { /* 读不到则下面报错 */ }
  }
  if (!apiKey) return { error: "该配置点无可用密钥（读不到 ANTHROPIC_AUTH_TOKEN）" };
  // 与 mind 现有调用同款拼法（global-organizer.compiled.js：`${baseUrl}/v1/messages`，base 不含 /v1）。
  const url = point.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey, // 仅在本次请求头使用；不记录、不回显
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: point.model,
        max_tokens: 32,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = await res.text().catch(() => "");
    let reply = "";
    try {
      const j = JSON.parse(text);
      reply = typeof j?.content?.[0]?.text === "string" ? j.content[0].text : "";
    } catch { /* 非 JSON：不回显原文，只报状态 */ }
    // 红绿判据（基线 §2）：HTTP 2xx + 非空回复 = 绿；空回复或非 2xx = 红（带状态码）。
    return { httpStatus: res.status, ok: res.ok && reply.trim().length > 0, replyFirst20: reply.trim().slice(0, 20) };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    return { error: msg.includes("abort") ? "测试调用超时（15s）" : "测试调用失败：" + msg.slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

// ── 配置点汇总（KPI 数据卡口径，基线 §5） ────────────────────────────────────

export interface KeyHealth {
  /** 文件-键对总数（来源文件数 × 键数），供分文件 hint 使用 */
  total: number;
  /** 各来源文件已配数之和（同样按文件-键对计） */
  configured: number;
  /** 键口径：MODEL_KEYS 总数（7） */
  keyTotal: number;
  /** 键口径：任一来源文件配了即算已配（与 missing 互补：globalConfigured + missing.length === keyTotal） */
  globalConfigured: number;
  /** 所有来源文件都没配的键 */
  missing: string[];
  sources: Array<{ file: string; configured: number; total: number }>;
}

/**
 * 键健康：按基线 §5「配置点数 = 已配置键数/总键数（分区块标注来源文件 mind/selfimproving）」。
 * 读的是**运行时真实生效的两个文件**（~/.config/lions/*.env），与区块 A/B 同源，
 * 避免读到仓库 .env（3107 工作树下不存在）而显示假 0。
 */
export function keyHealth(): KeyHealth {
  const dir = path.join(HOME, ".config", "lions");
  const files = [
    path.join(dir, "mind.env"),
    path.join(dir, "selfimproving-llm.env"),
  ];
  const sources: KeyHealth["sources"] = [];
  const seen = new Set<string>();
  let configured = 0;
  let total = 0;
  for (const file of files) {
    const label = path.basename(file);
    if (!fs.existsSync(file)) {
      sources.push({ file: label, configured: 0, total: MODEL_KEYS.length });
      total += MODEL_KEYS.length;
      continue;
    }
    let env: Record<string, string> = {};
    try { env = parseEnvText(fs.readFileSync(file, "utf8")); } catch { env = {}; }
    let n = 0;
    for (const k of MODEL_KEYS) {
      total++;
      if (env[k] && env[k].trim()) { n++; configured++; seen.add(k); }
    }
    sources.push({ file: label, configured: n, total: MODEL_KEYS.length });
  }
  // missing = **所有来源文件都没配**的键（全局缺失）。
  //   不按「任一文件缺」算：那样会出现 已配+缺失≠总数 的困惑（同一键可能只在其中一个文件配了）。
  const globallySet = new Set<string>();
  for (const f of files) {
    let env: Record<string, string> = {};
    try { if (fs.existsSync(f)) env = parseEnvText(fs.readFileSync(f, "utf8")); } catch { /* ignore */ }
    for (const k of MODEL_KEYS) if (env[k] && env[k].trim()) globallySet.add(k);
  }
  const missing = MODEL_KEYS.filter((k) => !globallySet.has(k));
  return { total, configured, keyTotal: MODEL_KEYS.length, globalConfigured: MODEL_KEYS.length - missing.length, missing, sources };
}

// ── 目录（provider/model 下拉数据源，基线 §依赖清单 ①） ─────────────────────

export interface CatalogProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  transport?: string;
  /** 发现模型=false 时必须显式列出，防切换到未登记模型 404 UnsupportedModel */
  discoverModels: boolean;
  models: string[];
  source: string;
}

/** 解析 hermes config.yaml 的 providers: 段（缩进宽松：models 列表项缩进 4 或 6 都认）。 */
export function parseHermesProviders(text: string): CatalogProvider[] {
  const out: CatalogProvider[] = [];
  const lines = text.split("\n");
  let inProviders = false;
  let cur: CatalogProvider | null = null;
  let inModels = false;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      if (line === "providers:") { inProviders = true; continue; }
      if (inProviders) { inProviders = false; cur = null; }
      continue;
    }
    if (!inProviders) continue;
    if (line.startsWith("- ")) { if (inModels && cur) cur.models.push(line.slice(2).trim()); continue; }
    // 供应商名含连字符（xiaomi-cn / minimax-cn / ark-plan），字符类必须放行 '-'，
    //   否则这些派单点名的供应商会整体漏解析（离线复算实测踩过）。
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, val] = kv;
    if (indent === 2) {
      cur = { id: key, discoverModels: false, models: [], source: "hermes" };
      out.push(cur);
      inModels = false;
      continue;
    }
    if (!cur) continue;
    if (key === "models") { inModels = true; continue; }
    inModels = false;
    if (key === "name") cur.name = val;
    else if (key === "api") cur.baseUrl = val;
    else if (key === "transport") cur.transport = val;
    else if (key === "discover_models") cur.discoverModels = val !== "false";
  }
  return out;
}

interface OpenClawCfg { agents?: { entries?: Record<string, { model?: { primary?: string; fallbacks?: string[] } }> }; models?: { providers?: Record<string, { baseUrl?: string; api?: string; models?: Array<{ id?: string }> }> } }

/** openclaw models.providers（JSON，apiKey 一律不读不回传）。 */
function openclawCatalog(): CatalogProvider[] {
  const file = path.join(HOME, ".openclaw", "openclaw.json");
  if (!fs.existsSync(file)) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as OpenClawCfg;
    const providers = cfg.models?.providers || {};
    return Object.entries(providers).map(([id, v]) => ({
      id,
      baseUrl: v.baseUrl,
      transport: v.api,
      discoverModels: false,
      models: (v.models || []).map((m) => m.id || "").filter(Boolean),
      source: "openclaw",
    }));
  } catch {
    return [];
  }
}

/**
 * provider/model 下拉数据源。
 * 三源合并（hermes / openclaw / dsh headless），同 id 合并 models 去重；
 * discoverModels=false 的必须原样列出 models —— 这是防「切换到未登记模型 -> 404 UnsupportedModel」的闸门。
 */
export function readCatalog(): { providers: CatalogProvider[]; asOf: string; reason?: string } {
  const providers: CatalogProvider[] = [];
  const hermesFile = path.join(HOME, ".hermes", "config.yaml");
  try {
    if (fs.existsSync(hermesFile)) providers.push(...parseHermesProviders(fs.readFileSync(hermesFile, "utf8")));
  } catch { /* 单源读失败不拖垮整体 */ }
  providers.push(...openclawCatalog());

  const byId = new Map<string, CatalogProvider>();
  for (const p of providers) {
    const exist = byId.get(p.id);
    if (!exist) { byId.set(p.id, { ...p, models: [...p.models] }); continue; }
    exist.models = Array.from(new Set([...exist.models, ...p.models]));
    exist.source = Array.from(new Set([...exist.source.split("+"), p.source])).join("+");
    if (!exist.baseUrl && p.baseUrl) exist.baseUrl = p.baseUrl;
    if (!exist.transport && p.transport) exist.transport = p.transport;
    exist.discoverModels = exist.discoverModels || p.discoverModels;
  }
  const list = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  return {
    providers: list,
    asOf: new Date().toISOString(),
    reason: list.length ? undefined : "模型供应商配置不可得（hermes/openclaw 配置均读不到）",
  };
}

// ── 审计回显（基线 §1「审计回显 s12」：只列变更键名，不列值） ─────────────────

export interface AuditRow {
  at: string;
  actor: string;
  action: string;
  /** 变更键名（来自审计 metadata.diffKeys），**绝不含值** */
  keys: string[];
  result: string;
}

function mindDbUrl(): string {
  if (process.env.PLATFORM_AUDIT_DB_URL) return process.env.PLATFORM_AUDIT_DB_URL;
  const conf = (process.env.HOME || "~") + "/.config/systemd/user/macs-platform.service.d/40-mind-auth.conf";
  try {
    const line = fs.readFileSync(conf, "utf8").split("\n").find((l) => l.includes("MIND_DATABASE_URL="));
    if (line) return line.split("MIND_DATABASE_URL=")[1].split("?")[0].trim();
  } catch { /* ignore */ }
  return process.env.MIND_DATABASE_URL || "";
}

let auditPool: Pool | null = null;

const AUDIT_ACTIONS = ["platform.config.update", "platform.config.write_failed", "platform.model.switch"];

/**
 * 最近 N 条配置变更审计。
 * 只取时间/操作者/动作/变更键名/结果；before/after/metadata 其余字段一律不回传
 * （metadata 里可能带文件路径与补偿信息，键值更不能出）。
 * 读不到 -> { ok:false, reason }，页面显示 n/a + 原因，不写 0。
 */
export async function readConfigAudits(limit = 10): Promise<{ ok: boolean; items?: AuditRow[]; reason?: string; asOf?: string }> {
  const url = mindDbUrl();
  if (!url) return { ok: false, reason: "审计库连接未配置" };
  try {
    if (!auditPool) auditPool = new Pool({ connectionString: url, max: 2 });
    const res = await auditPool.query(
      'SELECT "entityId", action, actor, metadata, "createdAt" FROM "AuditLog"' +
      ' WHERE action = ANY($1::text[]) ORDER BY "createdAt" DESC LIMIT $2',
      [AUDIT_ACTIONS, limit]
    );
    const items: AuditRow[] = res.rows.map((r: Record<string, unknown>) => {
      let keys: string[] = [];
      try {
        const m = typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata || {});
        keys = Array.isArray(m?.diffKeys) ? m.diffKeys.map(String) : [];
      } catch { keys = []; }
      const action = String(r.action || "");
      return {
        at: r.createdAt ? new Date(String(r.createdAt)).toISOString() : "",
        actor: String(r.actor || ""),
        action,
        keys,
        result: action.endsWith("failed") ? "失败（已拒绝写入）" : "成功",
      };
    });
    return { ok: true, items, asOf: new Date().toISOString() };
  } catch (e) {
    return { ok: false, reason: "审计读取失败：" + String((e as Error)?.message || e).slice(0, 80) };
  }
}
