"use client";
import type { DailyReport } from "./shared";
import Link from "next/link";
import { entityLabel } from "@/config/artifactTypes";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import styles from "../page.module.css";

/** 5 表产出（当日 / 前日 / 总量）；实体业务说法统一取 src/config/artifactTypes.ts */
export default function DailyProductionTable({ production }: { production: DailyReport["production"] }) {
  // 2026-10-19 B5: 每类产出链到它的资产页 —— 修前这一列是纯文本, 看到"知识 +32"却点不进去 ✗
  const TYPE_ROUTE: Record<string, string> = { memory: "/cognitive/memory", knowledge: "/cognitive/knowledge", reflection: "/cognitive/reflection", practice: "/cognitive/practice", skill: "/cognitive/skills" };
  // 2026-11-05 P2：手写 .tbl 表格换成白名单 DataTable（列与字段不变，只换呈现骨架）；
  //   环比涨跌色改由 data-tone 属性选择器表达，内联 style 清零。
  const rows = Object.entries(production).map(([type, p]) => ({
    type,
    today: p.today,
    prev: p.prev,
    total: p.total,
    diff: p.today - p.prev,
  }));
  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">飞轮产出（当日 / 前日 / 总量）</span></div>
      <TableCopyButton />
      <DataTable
        rowKey={(r) => r.type}
        rows={rows}
        empty={{ title: "暂无产出数据" }}
        columns={[
          {
            key: "type",
            title: "类型",
            render: (r) => (
              <Link href={TYPE_ROUTE[String(r.type).toLowerCase()] || "/flywheel"} className={styles.link}>{entityLabel(r.type)}</Link>
            ),
          },
          // 2026-10-13 round 76-DG: "环比" 拿**当日(可能才过几小时)**与**前日全天**比, 含义容易误读; 标明口径。
          { key: "today", title: "当日新增", align: "right", render: (r) => <span className={styles.num}>+{r.today.toLocaleString()}</span> },
          { key: "prev", title: "前日全天", align: "right", render: (r) => <span className={styles.num}>{r.prev.toLocaleString()}</span> },
          {
            key: "diff",
            title: "环比（对前日全天）",
            align: "right",
            render: (r) => (
              <span className={styles.num + " " + styles.diff} data-tone={r.diff >= 0 ? "ok" : "crit"}>
                {r.diff >= 0 ? "+" : ""}{r.diff.toLocaleString()}
              </span>
            ),
          },
          { key: "total", title: "活跃总量", align: "right", render: (r) => <span className={styles.num}>{r.total.toLocaleString()}</span> },
        ]}
      />
    </div>
  );
}
