"use client";
import type { DailyReport } from "./shared";

const QUALITY_LABELS: Record<string, string> = { high: "高", mid: "中", low: "低", zero: "未评分" };
const QUALITY_COLORS: Record<string, string> = { high: "var(--status-ok)", mid: "var(--status-warn)", low: "var(--text-dim)", zero: "var(--text-muted)" };
// 2026-10-13 round 76-T: 与 flywheel/_components/shared.ts 的 ERROR_COLORS 同源, 改用 --err-* 令牌(消除重复硬编码)
const ERROR_COLORS: Record<string, string> = { RATE_LIMIT: "var(--err-rate-limit)", SCHEMA_INVALID: "var(--err-schema)", NETWORK: "var(--err-network)", AUTH_ERROR: "var(--err-auth)", TIMEOUT: "var(--err-timeout)", UNKNOWN: "var(--err-unknown)", SERVER_ERROR: "var(--err-server)" };
// 原来用 (ERROR_COLORS[t] || 灰) + "22" 追加 alpha —— 值换成 var() 后不成立, 改用 color-mix。
const errBg = (t: string) => "color-mix(in srgb, " + (ERROR_COLORS[t] || "var(--err-unknown)") + " 13%, transparent)";

/** 数据质量 / 热门主题 / 改进任务 / 错误分类 */
export default function DailyQualityPanels({ d }: { d: DailyReport }) {
  return (
    <>
      <div className="grid-2">
        {/* 数据质量 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">数据质量（记忆）</span></div>
          <div style={{ display: "flex", gap: "var(--sp-3)", padding: "var(--sp-2) 0" }}>
            {Object.entries(d.quality).map(([k, v]) => (
              <div key={k} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, color: QUALITY_COLORS[k] || "var(--text)" }}>{v}</div>
                <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>{QUALITY_LABELS[k] || k}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 热门主题 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">热门主题</span></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", padding: "var(--sp-2) 0" }}>
            {d.themes.map((t) => (
              <span key={t.theme} className="badge badge-blue">{t.theme} <b>{t.count}</b></span>
            ))}
            {d.themes.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-base)" }}>无</span>}
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* 改进任务 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">改进任务</span></div>
          <div style={{ padding: "var(--sp-2) 0" }}>
            <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginBottom: "var(--sp-1)" }}>完成</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1-5)", marginBottom: "var(--sp-2-5)" }}>
              {d.tasks.done.map((t) => (
                <span key={t.type} className="badge badge-green">{t.type} <b>{t.count}</b></span>
              ))}
              {d.tasks.done.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-base)" }}>无</span>}
            </div>
            <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginBottom: "var(--sp-1)" }}>积压</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1-5)" }}>
              {d.tasks.pending.map((t) => (
                <span key={t.type} className="badge badge-red">{t.type} <b>{t.count}</b></span>
              ))}
              {d.tasks.pending.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-base)" }}>无</span>}
            </div>
          </div>
        </div>

        {/* 错误分类 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">错误分类</span></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", padding: "var(--sp-2) 0" }}>
            {d.errors.map((e) => (
              <span key={e.type} className="badge" style={{ background: errBg(e.type), color: ERROR_COLORS[e.type] || "var(--err-unknown)" }}>
                {e.type} <b>{e.count}</b>
              </span>
            ))}
            {d.errors.length === 0 && <span style={{ color: "var(--status-ok)", fontSize: "var(--fs-base)" }}>✅ 无错误</span>}
          </div>
        </div>
      </div>
    </>
  );
}
