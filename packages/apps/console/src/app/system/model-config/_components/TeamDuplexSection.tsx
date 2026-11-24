"use client";
/**
 * TeamDuplexSection —— 设置页「智能体团队 / 全双工」分组（0.6.2 U-51）
 *
 * 设计依据：docs/productization/AGENT-TEAM-CONFIG-DESIGN-2026-11-17.md §1
 *   字段名 agent_team / 秒制阈值 / overrides。
 *
 * 说明：设计文档的目标态是 enabled=true / mode=duplex；本项目缺省落**灰度安全**
 *   （enabled=false / mode=single = 现状），目标态写在下方说明里，避免误读。
 */
import { useCallback, useEffect, useState } from "react";
import { PageTitle } from "@/components/ui";
import styles from "./TeamDuplexSection.module.css";

type Mode = "duplex" | "single" | "auto";

interface AgentTeam {
  enabled: boolean; mode: Mode;
  turn_budget_seconds: number; long_task_threshold_seconds: number;
  require_subagent_for_long_task: boolean; interrupt_check_seconds: number;
  pending_alert_threshold: number; open_turns_alert_seconds: number;
  overrides: Record<string, { enabled?: boolean; mode?: Mode }>;
}
interface Settings { agent_team: AgentTeam }

const MODE_LABEL: Record<Mode, string> = { duplex: "强制外派（duplex）", single: "单会话（single）", auto: "按阈值自动（auto）" };
const NUM_FIELDS: { key: keyof AgentTeam; label: string; unit: string; hint: string }[] = [
  { key: "turn_budget_seconds", label: "单回合预算", unit: "秒", hint: "主会话单回合超过此值应触发 checkpoint" },
  { key: "long_task_threshold_seconds", label: "长任务阈值", unit: "秒", hint: "任务预计耗时超过此值 = 长任务（要求外派团队）" },
  { key: "interrupt_check_seconds", label: "中断检查间隔", unit: "秒", hint: "长任务执行中多久检查一次用户中断" },
  { key: "pending_alert_threshold", label: "pending 积压告警", unit: "条", hint: "待处理消息超过此值告警" },
  { key: "open_turns_alert_seconds", label: "open_turns 超时告警", unit: "秒", hint: "会话回合打开超过此值告警" },
];

export default function TeamDuplexSection({ embedded = false }: { embedded?: boolean }) {
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "unavailable">("loading");
  const [err, setErr] = useState("");
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState("");

  const load = useCallback(async () => {
    setPhase("loading"); setErr(""); setFlash("");
    try {
      const r = await fetch("/api/platform-settings", { cache: "no-store" });
      if (!r.ok) { setErr("设置接口 " + r.status); setPhase("error"); return; }
      const j = await r.json();
      if (!j.ok) { setErr("设置不可得" + (j.error ? ": " + j.error : "")); setPhase("unavailable"); return; }
      setS(j.settings); setPhase("ok");
    } catch { setErr("设置请求失败"); setPhase("error"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = async (body: any) => {
    setSaving(true); setFlash("");
    try {
      const r = await fetch("/api/platform-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { setFlash("保存失败: " + ((j && (j.error || (j.errors || []).join("; "))) || r.status)); return; }
      setS(j.settings); setFlash("已保存");
    } catch { setFlash("保存请求失败"); } finally { setSaving(false); }
  };

  const a = s?.agent_team;
  return (
    <section className={styles.wrap} aria-label="智能体团队 / 全双工">
      {!embedded && <PageTitle>智能体团队 / 全双工</PageTitle>}
      <p className={styles.note}>
        目标态是<b>开启团队、强制外派长任务</b>；当前缺省为<b>灰度安全</b>（关闭 / 单会话 = 与现状一致），
        打开开关后才按所选模式生效。
      </p>

      {phase === "loading" && <div className={styles.state}>加载中…</div>}
      {phase === "error" && <div className={styles.state}><b>加载失败</b><p>{err}</p><button className="btn" onClick={load}>重试</button></div>}
      {phase === "unavailable" && <div className={styles.state}><b>设置不可得</b><p>{err}</p><button className="btn" onClick={load}>重试</button></div>}

      {phase === "ok" && a && (
        <>
          <div className={styles.row}>
            <label className={styles.sw}>
              <input type="checkbox" checked={a.enabled} disabled={saving}
                onChange={(e) => patch({ enabled: e.target.checked })} />
              <span>启用会话智能体团队功能（总开关）</span>
            </label>
          </div>

          <div className={styles.row}>
            <div className={styles.label}>运行模式</div>
            <div className={styles.modes}>
              {(["single", "duplex", "auto"] as Mode[]).map((m) => (
                <label key={m} className={styles.radio + (a.mode === m ? " " + styles.radioOn : "")}>
                  <input type="radio" name="team-mode" checked={a.mode === m} disabled={saving || !a.enabled}
                    onChange={() => patch({ mode: m })} />
                  <span>{MODE_LABEL[m]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className={styles.grid}>
            {NUM_FIELDS.map((f) => (
              <label key={String(f.key)} className={styles.num}>
                <span className={styles.numLabel}>{f.label}<em>（{f.unit}）</em></span>
                <input type="number" min={0} step={f.unit === "条" ? 1 : 30}
                  defaultValue={Number(a[f.key] ?? 0)} disabled={saving}
                  onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v !== Number(a[f.key])) patch({ [f.key]: v }); }} />
                <span className={styles.hint}>{f.hint}</span>
              </label>
            ))}
          </div>

          <div className={styles.row}>
            <label className={styles.sw}>
              <input type="checkbox" checked={a.require_subagent_for_long_task} disabled={saving}
                onChange={(e) => patch({ require_subagent_for_long_task: e.target.checked })} />
              <span>长任务必须外派智能体团队</span>
            </label>
          </div>

          <div className={styles.overrides}>
            <div className={styles.label}>按线覆盖（overrides）</div>
            {Object.keys(a.overrides).length === 0 && <div className={styles.hint}>暂无覆盖（所有线继承全局设置）</div>}
            {Object.entries(a.overrides).map(([line, ov]) => (
              <div key={line} className={styles.ovRow}>
                <code>{line}</code>
                <span>mode: {ov.mode ?? "（继承）"}</span>
                <span>enabled: {ov.enabled === undefined ? "（继承）" : String(ov.enabled)}</span>
              </div>
            ))}
            <div className={styles.hint}>覆盖目前只读展示；编辑入口在下一批（U-52 设置中心）</div>
          </div>

          {flash && <div className={styles.flash + (flash.startsWith("已保存") ? " " + styles.flashOk : "")}>{flash}</div>}
        </>
      )}
    </section>
  );
}