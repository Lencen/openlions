"use client";
import { t } from "@/i18n";
import FilterTabs from "@/components/common/FilterTabs";
import { TASK_SCOPES, scopeDef } from "@/config/taskScopes";
import { chip, fmtNum } from "./shared";
import type { Counts, ScopeCount } from "./shared";

/** 作用域切换 + 状态/类型筛选栏 */
export default function TasksFilters({
  scope,
  status,
  type,
  themeQ,
  setScope,
  setType,
  setStatus,
  setThemeQ,
  counts,
  scopeCounts,
  scopeTypes,
}: {
  scope: string;
  status: string;
  type: string;
  themeQ: string;
  setScope: (v: string) => void;
  setType: (v: string) => void;
  setStatus: (v: string) => void;
  setThemeQ: (v: string) => void;
  counts: Counts;
  scopeCounts: Record<string, ScopeCount>;
  scopeTypes?: string[];
}) {
  const bs = counts.byStatus;
  const curScope = scopeDef(scope);
  // 类型按钮只显示当前 scope 内的类型 (避免把对话/验证任务混进机制修复视图)
  const typeOptions = (scopeTypes && scopeTypes.length ? scopeTypes : curScope.types);
  // 任务类型口径 (统计用, 2026-09-10): 机制修复类 = GOAL_GAP + THEME_IMPROVE + PLATFORM_REVIEW。
  // 注意: "改进任务" 的判定以**最初来源**为准 (飞轮自省), 见同页 QueueBoundary 卡片;
  //   平台质检 (产出验证/独立复核/决策落地) 应按边界归待办, 生成侧迁移进行中。
  const mech = scopeCounts.MECHANISM;
  const statusTabs = [["ALL", "全部"], ["PENDING", "待做"], ["IN_PROGRESS", "进行中"], ["DONE", "完成"], ["FAILED", "失败"]]
    .map(([v, l]) => ({ key: v, label: l, count: v !== "ALL" && bs[v] != null ? bs[v] : undefined }));

  return (
    <>
      <div className="panel"><div className="panel-header">
        <span className="panel-title">{t('tasks.panel.scope')}</span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>任务类型口径(2026-09-10): 机制修复类 = 目标缺口 + 主题改进 + 平台复审 —— 这是统计用类型分层；「改进任务」的来源判据见上方卡片（飞轮自省），平台质检类正按边界迁往待办。</span>
      </div>
        <div style={{ padding: "var(--sp-2-5) var(--sp-3-5)" }}>
          <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", alignItems: "center" }}>
            {TASK_SCOPES.map((s) => {
              const active = scope === s.key;
              const c = scopeCounts[s.key]?.count;
              return (
                <button
                  key={s.key}
                  title={s.desc}
                  onClick={() => { setScope(s.key); setType(""); }}
                  style={{
                    padding: "var(--sp-1) var(--sp-3-5)", borderRadius: "var(--radius-lg)", cursor: "pointer", fontSize: "var(--fs-base)",
                    border: "1px solid " + (active ? s.color : "var(--border)"),
                    // 2026-10-13 round 76-AR: s.color 已是令牌(var(--primary)…) —— 原来的 s.color + "22" 追加 alpha 会产出无效 CSS, 改 color-mix。
                    background: active ? "color-mix(in srgb, " + s.color + " 13%, transparent)" : "transparent",
                    color: active ? s.color : "inherit",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {s.short}{c != null ? " " + fmtNum(c) : ""}
                </button>
              );
            })}
            <span style={{ marginLeft: "auto", fontSize: "var(--fs-sm)", color: "var(--text-muted)", maxWidth: 520, lineHeight: 1.6 }}>
              <b style={{ color: curScope.color }}>{curScope.label}</b>：{curScope.desc}
            </span>
          </div>
          {mech ? (
            <div style={{ marginTop: "var(--sp-2)", fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
              {t('tasks.scope.breakdown', { mech: fmtNum(mech.count), verify: fmtNum(scopeCounts.VERIFY?.count ?? 0), dialog: fmtNum(scopeCounts.DISCUSSION?.count ?? 0) })}
            </div>
          ) : null}
        </div>
      </div>
      <div className="panel"><div className="panel-header"><span className="panel-title">状态 / 类型筛选</span></div>
        <div style={{ padding: "var(--sp-2-5) var(--sp-3-5)", display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", alignItems: "center" }}>
          <FilterTabs tabs={statusTabs} value={status} onChange={setStatus} />
          <span style={{ width: 1, height: 20, background: "var(--border)", margin: "0 var(--sp-1)" }} />
          <button onClick={() => setType("")} style={chip(type === "")}>{curScope.key === "ALL" ? "全部类型" : curScope.short + "·全部类型"}</button>
          {typeOptions.map((t) => (
            <button key={t} onClick={() => setType(type === t ? "" : t)} style={chip(type === t)}>{t}{counts.byType[t] != null ? " " + fmtNum(counts.byType[t]) : ""}</button>
          ))}
          <input value={themeQ} onChange={(e) => setThemeQ(e.target.value)} placeholder="主题关键词过滤…" style={{ marginLeft: "auto", padding: "var(--sp-1) var(--sp-2-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "transparent", color: "inherit", width: 200, fontSize: "var(--fs-base)" }} />
        </div>
      </div>
    </>
  );
}
