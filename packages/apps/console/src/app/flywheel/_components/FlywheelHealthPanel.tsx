"use client";
import KPICard from "@/components/KPICard";

/** 平台自我提升体检(黑盒 -> 一句话结论) */
export default function FlywheelHealthPanel({ health }: { health: any }) {
  if (!(health && health.ok)) return null;
  return (
    <div className="panel" style={{ border: "1px solid var(--border)", marginBottom: "var(--sp-3)" }}>
      <div className="panel-header"><span className="panel-title">🧭 平台自我提升体检</span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>更新 {health.ts ? new Date(health.ts).toLocaleString("zh-CN", { hour12: false }) : "-"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1-5)", fontSize: "var(--fs-md)" }}>
        {(health.verdict || []).map((v: any, i: number) => (
          <div key={i} style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-start" }}>
            <span style={{ flex: "0 0 auto" }}>{v.level === "crit" ? "🔴" : v.level === "warn" ? "🟠" : "🟢"}</span>
            <span style={{ color: v.level === "crit" ? "var(--status-crit)" : v.level === "warn" ? "var(--status-warn)" : "var(--text)" }}>{v.text}</span>
          </div>
        ))}
      </div>
      <div className="kpi-grid kpi-grid-secondary" style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", marginTop: "var(--sp-2-5)" }}>
        <KPICard label="改进任务·待处理" value={String((health.tasks?.pending || 0).toLocaleString())} />
        <KPICard label="任务·已完成" value={String((health.tasks?.done || 0).toLocaleString())} />
        {/* 2026-10-20 维度审计（B9-1）：原"执行器停滞(天)"恒为 0（gapDays=0）→ 无信息量，删。
            换成"执行失败率"——实测 7,592 / 13,278 = 57%，这才是真问题；"反思正常率"补上分子/分母。 */}
        <KPICard label="执行失败率" value={health.exec && health.exec.total ? Math.round((health.exec.fail / health.exec.total) * 100) + "%" : "-"} />
        {/* R2 维度合并：24h 认知写入与页首 hero 重复 → 删；反思正常率 + 失败条数 → 一张卡（失败放 delta） */}
        <KPICard label="反思正常率" value={health.reflection && health.reflection.total
          ? Math.round((health.reflection.ok / health.reflection.total) * 100) + "%"
          : "-"} delta={"失败 " + Number(health.reflection?.fail || 0).toLocaleString()} deltaDir="down" />
      </div>
    </div>
  );
}