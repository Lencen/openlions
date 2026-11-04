"use client"
import TableCopyButton from "@/components/TableCopyButton";
import { DetailSection } from "@/components/detail";
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
  return (
    <DetailSection title="能力分级（决定能认领什么任务）">
      <div style={{ marginBottom: "var(--sp-2)" }}>
        当前: {curTier === null
          ? <span className="badge badge-yellow">未登记(按最小权限 T0 处理)</span>
          : <span className={`badge ${curTier === 3 ? "badge-green" : ""}`}>T{curTier} {TIERS[curTier].split("(")[0].slice(3)}</span>}
        {profile.capabilityReason && <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginLeft: "var(--sp-2)" }}>{String(profile.capabilityReason).slice(0, 80)}</span>}
      </div>
      <TableCopyButton />
      <table className="tbl"><tbody>
        {TIERS.map((label, t) => (
          <tr key={t}>
            <td className="nowrap" style={{ width: 46 }}><b>T{t}</b></td>
            <td style={{ fontSize: "var(--fs-base)" }}>{label.slice(3)}</td>
            <td className="nowrap" style={{ width: 90 }}>
              {curTier === t
                ? <span className="badge badge-green">当前</span>
                : <button className="btn" style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-0-5) var(--sp-2)" }} disabled={tierBusy}
                    onClick={() => { if (confirm(`把 ${me.agent_id || agentId} 的能力分级设为 ${label}?`)) saveTier(t); }}>
                    {tierBusy ? "..." : "设为该级"}
                  </button>}
            </td>
          </tr>
        ))}
      </tbody></table>
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginTop: "var(--sp-1-5)" }}>
        只有 <b>T3</b> 能认领标题带 <span className="mono">[机制修复]</span> 的任务(需真改代码/查库/部署);
        派单缺能力时会明确回报"缺什么", 不会静默无活可干。
      </div>
    </DetailSection>
  );
}
