"use client";
// 2026-10-27：商业化 Gate 看板（console 只读）。范围按商业化线 v1.1 收缩：**只做这一块**。
//   授权状态页 / 销售 CTA / licence 详情全部延后到 S2，本页不含任何写操作。
//
// 三条硬约束（对方点名要求）：
//   1. 不在前端算指标 —— 通过数/红绿/剩余天数都由 BFF 算好，本页只显示；
//   2. 空数据/上游失败显示「未知」而不是 0 —— 显示 0 等于告诉用户"已经归零"；
//   3. 只读：没有按钮、不发 POST。
import { Alert, Skeleton, Tag } from "@/components/primitives";
import { useApi } from "@/lib/api";

interface GoalItem {
  id: string;
  value: number | null;
  target: number | null;
  direction: string | null;
  ok: boolean;
  missing: boolean;
  detail: string | null;
}

interface GateResp {
  ok?: boolean;
  asOf?: string;
  s1?: { deadline: string; daysLeft: number | null } | null;
  goals?: { at: string; total: number | null; okCount: number | null; missing: string[] | null; unmet: string[] | null; items: GoalItem[] } | null;
  readiness?: { total: number | null; pass: number | null; fail: number | null; failed: string[]; asOf: string; stale: boolean } | null;
  releaseGate?: { state: "green" | "red" | "unknown"; reasons: string[] } | null;
}

const UNKNOWN = "未知";

const fmtNum = (v: number | null) => (v === null ? UNKNOWN : v.toLocaleString("zh-CN"));

// 单位不能想当然：同类指标里既有比率（0–1）也有绝对量（如成本 569/4800、违规数 0）。
//   上游没有 unit 字段，所以按 id 显式登记；未登记的指标退回"原值"，绝不用百分比瞎猜。
type Unit = "ratio" | "count";
const UNIT: Record<string, Unit> = {
  "FW-GROW": "ratio",
  "FW-EVIDENCE": "ratio",
  "FW-QUALITY": "ratio",
  "FW-EXTRACT": "ratio",
  "PL-AUTONOMY": "ratio",
  "MACS-COLLAB": "ratio",
  "PL-TRUST": "count",
  "PL-COST": "count",
};

function fmtByUnit(id: string, v: number | null): string {
  if (v === null) return UNKNOWN;
  const unit = UNIT[id] ?? "count";
  return unit === "ratio" ? (v * 100).toFixed(1) + "%" : fmtNum(Math.round(v));
}

// 目标标识 → 业务名（页面不出现内部代号；新指标未登记时退回通用说法，不硬编码英文）
const GOAL_NAME: Record<string, string> = {
  "FW-GROW": "飞轮增长（落地率）",
  "FW-EVIDENCE": "证据完备率",
  "FW-QUALITY": "产物质量",
  "FW-EXTRACT": "提炼覆盖率",
  "PL-AUTONOMY": "自治率",
  "PL-TRUST": "自检可信（违约数）",
  "MACS-COLLAB": "协作闭环率",
  "PL-COST": "单位成本（平台读数）",
};

const fmtTime = (t?: string | null) => {
  if (!t) return UNKNOWN;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function CommercialGatePage() {
  const { data, loading, error } = useApi<GateResp>("/api/commercial-gate");

  const gate = data?.releaseGate ?? null;
  const goals = data?.goals ?? null;
  const rd = data?.readiness ?? null;
  const s1 = data?.s1 ?? null;

  const gateTag =
    gate?.state === "green" ? <Tag color="green">可放行</Tag>
    : gate?.state === "red" ? <Tag color="red">未通过</Tag>
    : <Tag>未知</Tag>;

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="page-header">
        <div className="page-title">商业化 Gate</div>
        <div className="page-subtitle">
          只读看板 · 目标达成、就绪检查与 S1 发布门禁 · 数据取自平台自身读数，本页不做计算
        </div>
      </div>

      {error ? (
        <Alert
          type="warning"
          showIcon
          title="读数暂时取不到"
          description="这表示看板拿不到数据，不代表指标为零；稍后刷新即可。"
          style={{ marginBottom: "var(--gap-block)" }}
        />
      ) : null}

      <div className="kpi-grid">
        <div className="panel">
          <div className="panel-header"><div className="panel-title" style={{ whiteSpace: "nowrap" }}>S1 发布门禁</div></div>
          <div style={{ padding: "var(--gap-tight) var(--gap-sect)" }}>
            <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>{gateTag}</div>
            <div className="tiny" style={{ marginTop: "var(--gap-label)" }}>
              {gate?.state === "unknown"
                ? "读数不完整，无法判定（不代表通过）"
                : gate?.reasons?.length
                  ? gate.reasons.join("；")
                  : "目标与就绪检查均通过"}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><div className="panel-title" style={{ whiteSpace: "nowrap" }}>距 S1 节点</div></div>
          <div style={{ padding: "var(--gap-tight) var(--gap-sect)" }}>
            <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>
              {s1?.daysLeft === null || s1?.daysLeft === undefined ? UNKNOWN : s1.daysLeft + " 天"}
            </div>
            <div className="tiny" style={{ marginTop: "var(--gap-label)" }}>节点日期 {s1?.deadline ?? UNKNOWN}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><div className="panel-title" style={{ whiteSpace: "nowrap" }}>就绪检查</div></div>
          <div style={{ padding: "var(--gap-tight) var(--gap-sect)" }}>
            <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>
              {rd?.pass === null || rd?.pass === undefined ? UNKNOWN : rd.pass + " / " + fmtNum(rd.total ?? null)}
            </div>
            <div className="tiny" style={{ marginTop: "var(--gap-label)" }}>
              {rd ? (rd.stale ? "快照稍旧，可能不是最新" : "快照时间 " + fmtTime(rd.asOf)) : "尚未生成快照"}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><div className="panel-title" style={{ whiteSpace: "nowrap" }}>目标达成</div></div>
          <div style={{ padding: "var(--gap-tight) var(--gap-sect)" }}>
            <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>
              {goals?.okCount === null || goals?.okCount === undefined ? UNKNOWN : goals.okCount + " / " + fmtNum(goals.total ?? null)}
            </div>
            <div className="tiny" style={{ marginTop: "var(--gap-label)" }}>
              {goals
                ? "读数时间 " + fmtTime(goals.at) +
                  (goals.missing?.length ? " · 缺数 " + goals.missing.length : "") +
                  (goals.unmet?.length ? " · 未达标 " + goals.unmet.length : "")
                : "目标读数暂时取不到"}
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: "var(--gap-block)" }}>
        <div className="panel-header"><div className="panel-title">目标指标明细</div></div>
        {loading ? (
          <Skeleton paragraph={{ rows: 6 }} />
        ) : goals?.items?.length ? (
          <div style={{ padding: "0 var(--gap-sect) var(--gap-block)" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 200 }}>指标</th>
                  <th style={{ width: 110 }}>当前值</th>
                  <th style={{ width: 110 }}>目标</th>
                  <th style={{ width: 90 }}>判定</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {goals.items.map((m) => {
                  const bad = m.missing || !m.ok;
                  return (
                    <tr key={m.id}>
                      <td>{GOAL_NAME[m.id] || m.id}</td>
                      <td className="mono">{fmtByUnit(m.id, m.value)}</td>
                      <td className="mono">{fmtByUnit(m.id, m.target)}</td>
                      {/* 2026-10-27：Tag 默认半透明底叠在表格行底色上时，绿色前景对比度只有 4.42:1（低于 4.5）。
                          这里给 Tag 一个实底，颜色不变、对比度回到达标区间。 */}
                      {/* 2026-10-27：缺数（窗口内无产物）与未达标（有数没到目标）是两种事实，判定列分开显示 */}
                      <td>
                        {m.missing ? (
                          <Tag style={{ background: "var(--bg-surface)" }}>缺数</Tag>
                        ) : bad ? (
                          <Tag color="red" style={{ background: "var(--bg-surface)" }}>未达标</Tag>
                        ) : (
                          <Tag color="green" style={{ background: "var(--bg-surface)" }}>达标</Tag>
                        )}
                      </td>
                      <td className="tiny" style={{ maxWidth: 620, whiteSpace: "normal" }}>
                        {m.missing ? (
                          "窗口内没有可用产物，按未达标处理（不是零值，而是无数据）"
                        ) : m.detail ? (
                          // 上游 detail 含内部代号与口径推导，默认收起，需要时再展开（不在首屏糊一屏术语）
                          <details>
                            <summary style={{ cursor: "pointer" }}>查看口径</summary>
                            <div style={{ marginTop: "var(--gap-label)", lineHeight: 1.7 }}>{m.detail}</div>
                          </details>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: "var(--gap-sect)" }} className="tiny">
            目标读数暂时取不到，显示为「未知」而不是 0。
          </div>
        )}
      </div>

      <div className="panel" style={{ marginTop: "var(--gap-block)" }}>
        <div className="panel-header"><div className="panel-title">未通过的就绪检查</div></div>
        <div style={{ padding: "0 var(--gap-sect) var(--gap-block)" }} className="tiny">
          {rd?.failed?.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {rd.failed.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          ) : rd ? (
            <div>全部通过。</div>
          ) : (
            <div>尚未生成快照，显示为「未知」而不是 0。</div>
          )}
        </div>
      </div>
    </main></div>
  );
}
