// Phase3 屏04 检查器 (InspectorPanel) — 服务端组件
// 作用: 把一次会话的"原始消息列表"现场派生出可观测的统计面板(角色分布 / 长度直方图 / 模型使用 / 工具调用),
//       免新增 BFF, 直接复用 /api/session-detail 已经返回的 messages[]。
// 适用: 嵌在 /sessions/detail 右侧; 老屏不挂, InspectorPanel 仅作为该屏"派生观察"层,
//       不接管会话元数据(那部分仍在 page.tsx 的『会话信息』面板里)。
// 关键约束: 不重复请求数据; 所有统计在服务端算完, HTML 直接带数字 (curl 可验)。
// A-F 图型引用: 本组件用 <DistributionBar> (C 型, 已存在 BarChart 包装) 画长度直方图; 角色/模型
//   排行复用 <RankBar> (E 型, KPICard 内的条形基元)。InspectorPanel 自身不引图表库, 只调语义化封装。

import BarChart from "@/components/BarChart";
import KPICard from "@/components/KPICard";
import TableCopyButton from "@/components/TableCopyButton";
import { statusLabel } from "@/config/systemLabels";

export interface InspectorMessage {
  messageUid: string;
  role: string;
  content: string;
  createdAt: string | null;
  model?: string | null;
}

export interface InspectorPanelProps {
  messages: InspectorMessage[];
  /** 归档登记里的状态 (PROCESSED / PENDING / FAILED / SKIPPED), 用于展示一个『平台已处置』徽标 */
  registryStatus?: string | null;
  /** 来自 sessionRegistry 的处理备注 (processing_error), 用于解释为什么 SKIPPED */
  processingNote?: string | null;
}

interface RoleStat { role: string; label: string; count: number; }
interface ModelStat { model: string; count: number; }
interface LengthBucket { label: string; range: [number, number]; count: number; }

const ROLE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "智能体",
  system: "系统",
  tool: "工具",
};

function bucketLabel(lo: number, hi: number): string {
  if (hi === Infinity) return `≥${lo}`;
  if (lo === hi) return `=${lo}`;
  return `${lo}-${hi}`;
}

function computeLengthBuckets(messages: InspectorMessage[]): LengthBucket[] {
  // 字符数直方图 (按 100/500/2k/10k 切); 0-100 = 短句, 100-500 = 普通, 500-2k = 长段, 2k-10k = 长文, ≥10k = 巨型。
  const buckets: LengthBucket[] = [
    { label: bucketLabel(0, 100), range: [0, 100], count: 0 },
    { label: bucketLabel(100, 500), range: [100, 500], count: 0 },
    { label: bucketLabel(500, 2000), range: [500, 2000], count: 0 },
    { label: bucketLabel(2000, 10000), range: [2000, 10000], count: 0 },
    { label: bucketLabel(10000, Infinity), range: [10000, Infinity], count: 0 },
  ];
  for (const m of messages) {
    const len = (m.content || "").length;
    for (const b of buckets) {
      if (len >= b.range[0] && len < b.range[1]) { b.count += 1; break; }
      if (b.range[1] === Infinity && len >= b.range[0]) { b.count += 1; break; }
    }
  }
  return buckets;
}

function colorForRole(role: string): string {
  if (role === "user") return "var(--primary)";
  if (role === "assistant") return "var(--table-memory)";
  if (role === "system") return "var(--text-3)";
  if (role === "tool") return "var(--status-warn)";
  return "var(--text-muted)";
}

export default function InspectorPanel({ messages, registryStatus, processingNote }: InspectorPanelProps) {
  const total = messages.length;

  // 角色分布
  const byRoleMap = new Map<string, number>();
  for (const m of messages) byRoleMap.set(m.role, (byRoleMap.get(m.role) ?? 0) + 1);
  const byRole: RoleStat[] = Array.from(byRoleMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => ({ role, label: ROLE_LABEL[role] || role || "未知", count }));

  // 模型分布 (缺失归到 "(未标记)")
  const byModelMap = new Map<string, number>();
  for (const m of messages) {
    const key = (m.model || "").trim() || "(未标记)";
    byModelMap.set(key, (byModelMap.get(key) ?? 0) + 1);
  }
  const byModel: ModelStat[] = Array.from(byModelMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([model, count]) => ({ model, count }));

  // 长度直方图 + 总字数
  const totalChars = messages.reduce((s, m) => s + (m.content || "").length, 0);
  const avgChars = total ? Math.round(totalChars / total) : 0;
  const buckets = computeLengthBuckets(messages);

  // 空消息数 (内容是空 / 全空白)
  const emptyCount = messages.filter((m) => !(m.content || "").trim()).length;

  // 时间跨度: 最早 vs 最晚 (createdAt)
  const tsList = messages.map((m) => (m.createdAt ? Date.parse(m.createdAt) : NaN)).filter(Number.isFinite);
  const spanMs = tsList.length >= 2 ? Math.max(...tsList) - Math.min(...tsList) : 0;
  const spanHuman = spanMs <= 0 ? "—" : spanMs < 60_000 ? `${Math.round(spanMs / 1000)} 秒` :
    spanMs < 3_600_000 ? `${Math.round(spanMs / 60_000)} 分钟` :
    spanMs < 86_400_000 ? `${(spanMs / 3_600_000).toFixed(1)} 小时` :
    `${(spanMs / 86_400_000).toFixed(1)} 天`;

  return (
    <aside aria-label="会话检查器" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      {/* 顶部 KPI: 总数 / 总字数 / 平均长度 / 时间跨度 */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <KPICard label="消息总数" value={total.toLocaleString()} />
        <KPICard label="总字符数" value={totalChars.toLocaleString()} />
        <KPICard label="平均长度" value={`${avgChars.toLocaleString()} 字`} />
        <KPICard label="时间跨度" value={spanHuman} />
      </div>

      {/* 角色分布 (E 型 — RankBar 复用 BarChart 包装) */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">角色分布</span>
        </div>
        {byRole.length === 0 ? (
          <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)" }}>无消息可统计</div>
        ) : (
          <div style={{ padding: "var(--sp-3)" }}>
            <BarChart
              bars={byRole.map((r) => ({
                label: r.label,
                value: r.count,
                color: colorForRole(r.role),
              }))}
            />
          </div>
        )}
      </div>

      {/* 长度直方图 (C 型 — DistributionBar) */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">消息长度直方图</span>
        </div>
        {total === 0 ? (
          <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)" }}>无消息可统计</div>
        ) : (
          <div style={{ padding: "var(--sp-3)" }}>
            <BarChart
              bars={buckets.map((b, i) => ({
                label: b.label,
                value: b.count,
                // 同一语义色, 渐变靠 --brand; E 型不变, 这里给分布条加颜色提示避免 0 计数看不见
                color: i === buckets.length - 1 ? "var(--info)" : "var(--brand)",
              }))}
            />
          </div>
        )}
      </div>

      {/* 模型使用 (E 型 — RankBar) */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">模型使用</span>
        </div>
        {byModel.length === 0 ? (
          <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)" }}>无消息可统计</div>
        ) : (
          <div style={{ padding: "var(--sp-3)" }}>
            <BarChart
              bars={byModel.map((m) => ({
                label: m.model,
                value: m.count,
                color: "var(--brand)",
              }))}
            />
          </div>
        )}
      </div>

      {/* 平台处置: 让用户立即看到归档状态 / 处理备注, 解释『为什么 SKIPPED』 */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">平台处置</span>
        </div>
        <TableCopyButton />
        <table className="tbl">
          <tbody>
            <tr>
              <th style={{ width: 110 }}>归档状态</th>
              <td>
                <span
                  className={
                    // 2026-10-26：活库状态键是 DONE，这里原来只认 PROCESSED/FAILED/PENDING →
                    //   9,899 行 DONE 会落到 badge-blue 并**原样印出英文 "DONE"**（与 SessionsTable 同一个漏点）。
                    registryStatus === "DONE" || registryStatus === "PROCESSED" ? "badge badge-green" :
                    registryStatus === "FAILED" ? "badge badge-red" :
                    registryStatus === "PENDING" ? "badge badge-yellow" :
                    "badge badge-blue"
                  }
                >
                  {registryStatus ? (statusLabel(registryStatus) || registryStatus) : "—"}
                </span>
              </td>
            </tr>
            <tr>
              <th>空消息</th>
              <td className="num">{emptyCount.toLocaleString()} 条</td>
            </tr>
            {processingNote ? (
              <tr>
                <th>处理备注</th>
                <td style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>{processingNote}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </aside>
  );
}