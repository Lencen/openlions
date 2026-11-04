"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ApiResponse } from "./types";
import { DIMENSIONS, cp, ci, ctime } from "./caliber";
import DataMoment from "@/components/DataMoment";

const TABS = [
  { id: "overview", href: "/flywheel/business", label: "总览" },
  ...DIMENSIONS.map((d) => ({ id: d.id, href: d.href, label: d.code + " " + d.title })),
];

export default function BusinessShell({
  data, active, title, subtitle, onRefresh, refreshing, children,
}: {
  data: ApiResponse;
  active: string;
  title: string;
  subtitle: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
  children: ReactNode;
}) {
  const s = data.data;
  const b = (s && s.business) || {};
  const health = b.health || {};
  const regime = b.regime || {};
  const win = (s && s.window) || {};
  const fileName = data.path ? data.path.split("/").pop() : "—";
  const tone = data.degraded ? "var(--status-crit)" : data.stale ? "var(--status-warn)" : "var(--status-ok)";
  const toneLabel = data.degraded ? "业务扩展缺失" : data.stale ? "快照偏旧" : "快照正常";

  return (
    <div className="layout-with-sidebar">
      <main className="main" data-testid="flywheel-business">
        <div className="page-header">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "var(--sp-3)", flexWrap: "wrap" }}>
            <div>
              <div className="page-title">飞轮业务看板 · {title}</div>
              <div className="page-subtitle">{subtitle}</div>
            </div>
            <div className="tiny" style={{ textAlign: "right", color: "var(--text-muted)", lineHeight: 1.7 }}>
              <div>数据截至 {ctime(data.asOf)}（Asia/Shanghai）</div>
              <div>窗口 {win.label || "—"} · {win.timezone || "UTC"}</div>
              <div>阶段 {regime.current || "—"} · {regime.label || "未标注"} · 跨阶段可比：{regime.comparable === false ? "否" : "是"}</div>
              <div>数据健康 {health.score == null ? "不可测" : ci(health.score) + "/100"} · 健康红线 {ci((health.redlines || []).length)} 项</div>
              <DataMoment items={[{ label: "快照", at: data.asOf }]} />
            </div>
          </div>
        </div>

        <nav aria-label="业务维度" style={{ display: "flex", gap: 4, flexWrap: "wrap", borderBottom: "1px solid var(--border)", paddingBottom: 8, marginBottom: 4 }}>
          {TABS.map((t) => {
            const on = active === t.id;
            return (
              <Link key={t.id} href={t.href} data-tab={t.id}
                style={{
                  padding: "6px 10px", borderRadius: "var(--radius-sm)", whiteSpace: "nowrap",
                  color: on ? "var(--primary)" : "var(--text-dim)",
                  background: on ? "var(--primary-dim)" : "transparent",
                  fontWeight: on ? 600 : 400,
                }}>
                {t.label}
              </Link>
            );
          })}
        </nav>

        <div className="panel" style={{ padding: "var(--sp-2) var(--sp-3)", borderLeft: "3px solid " + tone, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-3)", flexWrap: "wrap" }}>
          <div className="tiny" style={{ lineHeight: 1.6 }}>
            <strong style={{ color: tone }}>{toneLabel}</strong>
            {data.ageMinutes != null ? <span style={{ color: "var(--text-muted)" }}> · 生成于 {data.ageMinutes} 分钟前</span> : null}
            {data.notice ? <span style={{ color: "var(--text-dim)" }}> · {data.notice}</span> : null}
            {!data.notice ? <span style={{ color: "var(--text-muted)" }}> · 文件 {fileName} · 来源 {data.source === "business" ? "业务扩展快照" : "权威快照"}</span> : null}
          </div>
          <button className="ui-btn ui-btn-small ui-btn-default" onClick={onRefresh} disabled={refreshing} type="button">
            {refreshing ? "生成中…" : "重新生成快照"}
          </button>
        </div>

        {children}

        <section className="panel" style={{ padding: "var(--sp-3)" }}>
          <div className="panel-title">口径、血缘与无数据规则</div>
          <div className="tiny" style={{ color: "var(--text-muted)", lineHeight: 1.75, marginTop: 6 }}>
            <div>唯一数据入口：<code>run/flywheel-business-snapshot-latest.json</code>（权威契约 v1 + 业务扩展）；页面不直接读业务表。</div>
            <div>权威快照由 <code>node scripts/flywheel-report.cjs --hours=24 --write</code> 产出；业务扩展由 <code>node scripts/flywheel-business-report.cjs --hours=24 --write</code> 产出。</div>
            <div>无数据 ≠ 达标：所有不可测项用灰色“无数据”标注，并在 D3 的“无数据 / 不完整项”给出原因与复算命令，不画成 0。</div>
            <div>时间：业务表 UTC；审计记录 Asia/Shanghai 本地墙钟；页面统一按 Asia/Shanghai 展示并标注。</div>
            <div>词元：网关通道级为总量；平台内部单列；逐智能体归因只做参考；三者不相加；单价未配，不出精确金额。</div>
            <div>阶段：R1 ≤ 2026-10-08 / R2 2026-10-09–10-21 / R3 ≥ 2026-10-22；跨阶段不直接比较。</div>
            {b.canonicalWarnings && b.canonicalWarnings.length ? <div>权威口径警示：{b.canonicalWarnings.map((w: any) => w.field).join(" / ")}（详见 D3）。</div> : null}
            {data.degraded ? <div style={{ color: "var(--status-crit)" }}>当前业务扩展缺失：先运行生成命令，再刷新本页。</div> : null}
          </div>
        </section>
      </main>
    </div>
  );
}
