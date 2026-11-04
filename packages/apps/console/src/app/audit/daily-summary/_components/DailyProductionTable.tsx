"use client";
import type { DailyReport } from "./shared";
import Link from "next/link";
import { entityLabel } from "@/config/artifactTypes";
import TableCopyButton from "@/components/TableCopyButton";

/** 5 表产出（当日 / 前日 / 总量）；实体业务说法统一取 src/config/artifactTypes.ts */
export default function DailyProductionTable({ production }: { production: DailyReport["production"] }) {
  // 2026-10-19 B5: 每类产出链到它的资产页 —— 修前这一列是纯文本, 看到"知识 +32"却点不进去 ✗
  const TYPE_ROUTE: Record<string, string> = { memory: "/cognitive/memory", knowledge: "/cognitive/knowledge", reflection: "/cognitive/reflection", practice: "/cognitive/practice", skill: "/cognitive/skills" };
  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">飞轮产出（当日 / 前日 / 总量）</span></div>
      <TableCopyButton />
      <table className="tbl">
        {/* 2026-10-13 round 76-DG: "环比" 拿**当日(可能才过几小时)**与**前日全天**比, 含义容易误读; 标明口径。 */}
        <thead><tr><th>类型</th><th>当日新增</th><th>前日全天</th><th>环比（对前日全天）</th><th>活跃总量</th></tr></thead>
        <tbody>
          {Object.entries(production).map(([t, p]) => {
            const diff = p.today - p.prev;
            return (
              <tr key={t}>
                <td><Link href={TYPE_ROUTE[String(t).toLowerCase()] || "/flywheel"} style={{ color: "var(--primary)" }}>{entityLabel(t)}</Link></td>
                <td className="num">+{p.today.toLocaleString()}</td>
                <td className="num">{p.prev.toLocaleString()}</td>
                <td className="num" style={{ color: diff >= 0 ? "var(--status-ok)" : "var(--status-crit)" }}>{diff >= 0 ? "+" : ""}{diff.toLocaleString()}</td>
                <td className="num">{p.total.toLocaleString()}</td>
              </tr>
            );
          })}
          {Object.keys(production).length === 0 && <tr><td colSpan={5} style={{ padding: "var(--sp-4)", color: "var(--text-muted)", textAlign: "center" }}>暂无产出数据</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
