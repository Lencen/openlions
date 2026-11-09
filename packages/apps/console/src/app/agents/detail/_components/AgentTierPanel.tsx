"use client"
// 2026-11-05 P2 批9（呈现层）：内联 style 清零 + 手写 .tbl 裸表 → 白名单 @/components/DataTable；
//   分级档位、文案、设级交互（confirm + saveTier）一字未改。
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { DetailSection } from "@/components/detail";
import styles from "./AgentTierPanel.module.css";
// agents/detail 页 · 能力分级面板 (从 page.tsx 抽出)
export default function AgentTierPanel({
  curTier,
  TIERS,
  profile,
  tierBusy,
  saveTier,
  me,
  agentId,
}: {
  curTier: number | null;
  TIERS: string[];
  profile: any;
  tierBusy: boolean;
  saveTier: (t: number) => void;
  me: any;
  agentId: string;
}) {
  // 2026-11-05 P2 批9：列与改前表格逐列对应（分级 / 说明 / 操作）。
  //   本组件是客户端组件（文件头 "use client"），可以传函数列（render / rowKey）。
  const rows = TIERS.map((label, t) => ({ t, label }));
  const columns: DataColumn<{ t: number; label: string }>[] = [
    { key: "tier", title: "分级", width: 50, render: (r) => <b className="nowrap">T{r.t}</b> },
    { key: "label", title: "说明", render: (r) => <span className={styles.cellBase}>{r.label.slice(3)}</span> },
    {
      key: "action",
      title: "操作",
      width: 90,
      render: (r) =>
        curTier === r.t ? (
          <span className="badge badge-green">当前</span>
        ) : (
          <button className={"btn " + styles.tierBtn} disabled={tierBusy}
            onClick={() => { if (confirm(`把 ${me.agent_id || agentId} 的能力分级设为 ${r.label}?`)) saveTier(r.t); }}>
            {tierBusy ? "..." : "设为该级"}
          </button>
        ),
    },
  ];
  return (
    <DetailSection title="能力分级（决定能认领什么任务）">
      <div className={styles.headerRow}>
        当前: {curTier === null
          ? <span className="badge badge-yellow">未登记(按最小权限 T0 处理)</span>
          : <span className={`badge ${curTier === 3 ? "badge-green" : ""}`}>T{curTier} {TIERS[curTier].split("(")[0].slice(3)}</span>}
        {profile.capabilityReason && <span className={styles.reason}>{String(profile.capabilityReason).slice(0, 80)}</span>}
      </div>
      <TableCopyButton />
      {/* 2026-11-05 P2 批9：裸 .tbl → 白名单 DataTable；行 key 取分级序号 */}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.t} />
      <div className={styles.footNote}>
        只有 <b>T3</b> 能认领标题带 <span className="mono">[机制修复]</span> 的任务(需真改代码/查库/部署);
        派单缺能力时会明确回报"缺什么", 不会静默无活可干。
      </div>
    </DetailSection>
  );
}
