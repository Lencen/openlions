/**
 * platform-settings.ts —— 平台设置单一事实源（0.6.2 U-51/U-52）
 *
 * 设计依据：docs/productization/AGENT-TEAM-CONFIG-DESIGN-2026-11-17.md §1
 *   （用户 2026-11-17 确认方向；字段名 agent_team / 秒制阈值 / overrides）
 *
 * 缺省值 = **灰度安全**（enabled=false / mode=single），与现状一致、向后兼容；
 *   设计文档的目标态（enabled=true / mode=duplex）作为「设置页说明文案」展示，不写进缺省。
 *
 * 文件位置：LIONS_PLATFORM_SETTINGS 环境变量可覆盖；
 *   **默认 ~/.config/macs/platform-settings.json**（2026-11-18 01:24 与 [team] 对齐的定稿路径；
 *   与 scripts/macs-team-create.cjs:26 / check-team-language.cjs:23 的既有读取路径一致；用户配置不入仓库）
 */
import fs from "fs";
import path from "path";

export type TeamMode = "duplex" | "single" | "auto";

/** 0.6.3 U-49：平台语言（auto=跟随系统；zh-CN / en-US 显式指定） */
export type TeamLanguage = "auto" | "zh-CN" | "en-US";
export const LANGUAGES: TeamLanguage[] = ["auto", "zh-CN", "en-US"];
export const DEFAULT_TEAM_LANGUAGE: TeamLanguage = "auto";

export interface AgentTeamSettings {
  enabled: boolean;
  mode: TeamMode;
  /** 单回合预算（秒） */
  turn_budget_seconds: number;
  /** 长任务阈值（秒）：超过即视为长任务 */
  long_task_threshold_seconds: number;
  /** 长任务是否强制外派智能体团队 */
  require_subagent_for_long_task: boolean;
  /** 中断检查间隔（秒） */
  interrupt_check_seconds: number;
  /** pending 积压告警阈值（条） */
  pending_alert_threshold: number;
  /** open_turns 超时告警（秒） */
  open_turns_alert_seconds: number;
  /** 按线覆盖（只覆盖显式给出的字段） */
  overrides: Record<string, Partial<Pick<AgentTeamSettings, "enabled" | "mode">>>;
}

export interface PlatformSettings {
  agent_team: AgentTeamSettings;
  /** 0.6.3 U-49：平台语言（与 agent_team 平级的顶级键；check-team-language.cjs 读同一份文件） */
  team_language: TeamLanguage;
}

/** 灰度安全缺省（= 现状；开关打开才走 duplex/auto） */
export const DEFAULT_AGENT_TEAM: AgentTeamSettings = {
  enabled: false,
  mode: "single",
  turn_budget_seconds: 300,
  long_task_threshold_seconds: 600,
  require_subagent_for_long_task: true,
  interrupt_check_seconds: 60,
  pending_alert_threshold: 5,
  open_turns_alert_seconds: 300,
  overrides: {},
};

export const DEFAULT_SETTINGS: PlatformSettings = {
  agent_team: DEFAULT_AGENT_TEAM,
  team_language: DEFAULT_TEAM_LANGUAGE,
};

const MODES: TeamMode[] = ["duplex", "single", "auto"];

export function settingsPath(): string {
  const p = process.env.LIONS_PLATFORM_SETTINGS;
  if (p && p.trim()) return path.resolve(p.trim());
  // 定稿路径（与 [team] / 既有 scripts 一致）
  return path.join(process.env.HOME || "~", ".config/macs/platform-settings.json");
}

export interface LoadResult { ok: boolean; settings: PlatformSettings; source: string; error?: string }

/** 读设置：文件不存在 -> 缺省安全值（不报错）；解析失败 -> 缺省 + error */
export function loadSettings(): LoadResult {
  const p = settingsPath();
  if (!fs.existsSync(p)) {
    return { ok: true, settings: { ...DEFAULT_SETTINGS }, source: "defaults（文件不存在: " + p + "）" };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return { ok: true, settings: mergeWithDefaults(raw), source: p };
  } catch (e: any) {
    return { ok: false, settings: { ...DEFAULT_SETTINGS }, source: p, error: "解析失败: " + String(e?.message || e).slice(0, 120) };
  }
}

/** 用缺省补齐 + 严格校验（非法值回退缺省并在 error 里报） */
export function mergeWithDefaults(raw: any): PlatformSettings {
  const src = (raw && typeof raw === "object" && raw.agent_team && typeof raw.agent_team === "object") ? raw.agent_team : {};
  const d = DEFAULT_AGENT_TEAM;
  const mode = MODES.includes(src.mode) ? src.mode : d.mode;
  const num = (v: any, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt);
  const bool = (v: any, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const overrides: AgentTeamSettings["overrides"] = {};
  if (src.overrides && typeof src.overrides === "object") {
    for (const [line, ov] of Object.entries(src.overrides)) {
      if (!ov || typeof ov !== "object") continue;
      const o: any = {};
      if (typeof (ov as any).enabled === "boolean") o.enabled = (ov as any).enabled;
      if (MODES.includes((ov as any).mode)) o.mode = (ov as any).mode;
      if (Object.keys(o).length) overrides[line] = o;
    }
  }
  // 0.6.3 U-49：team_language 是顶级键（不在 agent_team 内）
  const rawLang = raw && typeof raw === "object" ? raw.team_language : undefined;
  const team_language: TeamLanguage = LANGUAGES.includes(rawLang) ? rawLang : DEFAULT_TEAM_LANGUAGE;
  return {
    team_language,
    agent_team: {
      enabled: bool(src.enabled, d.enabled),
      mode,
      turn_budget_seconds: num(src.turn_budget_seconds, d.turn_budget_seconds),
      long_task_threshold_seconds: num(src.long_task_threshold_seconds, d.long_task_threshold_seconds),
      require_subagent_for_long_task: bool(src.require_subagent_for_long_task, d.require_subagent_for_long_task),
      interrupt_check_seconds: num(src.interrupt_check_seconds, d.interrupt_check_seconds),
      pending_alert_threshold: num(src.pending_alert_threshold, d.pending_alert_threshold),
      open_turns_alert_seconds: num(src.open_turns_alert_seconds, d.open_turns_alert_seconds),
      overrides,
    },
  };
}

/** 校验 PATCH 入参（只接受白名单字段；返回 { ok, errors, patch }） */
export function validatePatch(body: any): { ok: boolean; errors: string[]; patch: Record<string, any>; topLevel: Record<string, any> } {
  const errors: string[] = [];
  const patch: Record<string, any> = {};
  // 0.6.3 U-49：顶级键（与 agent_team 平级），如 team_language
  const topLevel: Record<string, any> = {};
  if (!body || typeof body !== "object") return { ok: false, errors: ["body 必须是对象"], patch, topLevel };
  const allowed: Record<string, "bool" | "num" | "mode" | "overrides"> = {
    enabled: "bool",
    mode: "mode",
    turn_budget_seconds: "num",
    long_task_threshold_seconds: "num",
    require_subagent_for_long_task: "bool",
    interrupt_check_seconds: "num",
    pending_alert_threshold: "num",
    open_turns_alert_seconds: "num",
    overrides: "overrides",
  };
  for (const [k, kind] of Object.entries(allowed)) {
    const v = body[k];
    if (v === undefined) continue;
    if (kind === "bool") { if (typeof v !== "boolean") errors.push(k + " 必须是布尔"); else patch[k] = v; }
    else if (kind === "num") { if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(k + " 必须是非负数字"); else patch[k] = Math.floor(v); }
    else if (kind === "mode") { if (!MODES.includes(v)) errors.push("mode 只能是 " + MODES.join("|")); else patch[k] = v; }
    else if (kind === "overrides") {
      if (!v || typeof v !== "object") { errors.push("overrides 必须是对象"); continue; }
      const ov: any = {};
      for (const [line, o] of Object.entries(v)) {
        if (!o || typeof o !== "object") { errors.push("overrides." + line + " 必须是对象"); continue; }
        const oo: any = {};
        if ((o as any).enabled !== undefined) { if (typeof (o as any).enabled !== "boolean") errors.push("overrides." + line + ".enabled 必须是布尔"); else oo.enabled = (o as any).enabled; }
        if ((o as any).mode !== undefined) { if (!MODES.includes((o as any).mode)) errors.push("overrides." + line + ".mode 非法"); else oo.mode = (o as any).mode; }
        if (Object.keys(oo).length) ov[line] = oo;
      }
      patch[k] = ov;
    }
  }
  // 0.6.3 U-49：team_language 顶级键校验（枚举）
  if (body.team_language !== undefined) {
    if (!LANGUAGES.includes(body.team_language)) errors.push("team_language 只能是 " + LANGUAGES.join("|"));
    else topLevel.team_language = body.team_language;
  }
  for (const k of Object.keys(body)) {
    if (k !== "team_language" && !(k in allowed)) errors.push("未知字段 " + k + "（白名单外的键不允许写）");
  }
  return { ok: errors.length === 0, errors, patch, topLevel };
}

/** 读原始 JSON（保留未知顶层键，如 team_language） */
export function loadRaw(): { ok: boolean; raw: any; path: string; error?: string } {
  const p = settingsPath();
  if (!fs.existsSync(p)) return { ok: true, raw: {}, path: p };
  try { return { ok: true, raw: JSON.parse(fs.readFileSync(p, "utf8")), path: p }; }
  catch (e: any) { return { ok: false, raw: {}, path: p, error: String(e?.message || e).slice(0, 120) }; }
}

/** 原子写原始 JSON（PATCH 用，保留未知顶层键） */
export function saveRaw(raw: any): { ok: boolean; path: string; error?: string } {
  return saveSettingsRaw(raw);
}

function saveSettingsRaw(raw: any): { ok: boolean; path: string; error?: string } {
  const p = settingsPath();
  const dir = path.dirname(p);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + ".partial";
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e: any) {
    return { ok: false, path: p, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 原子写：.partial + rename（避免半写坏文件） */
export function saveSettings(next: PlatformSettings): { ok: boolean; path: string; error?: string } {
  const p = settingsPath();
  const dir = path.dirname(p);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + ".partial";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e: any) {
    return { ok: false, path: p, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 取某条线的生效值（overrides 优先于全局） */
export function effectiveForLine(s: PlatformSettings, line: string): { enabled: boolean; mode: TeamMode; mergedFrom: "override" | "global" } {
  const g = s.agent_team;
  const o = g.overrides[line];
  if (o && (o.enabled !== undefined || o.mode !== undefined)) {
    return { enabled: o.enabled !== undefined ? o.enabled : g.enabled, mode: o.mode !== undefined ? o.mode : g.mode, mergedFrom: "override" };
  }
  return { enabled: g.enabled, mode: g.mode, mergedFrom: "global" };
}