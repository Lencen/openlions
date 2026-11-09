"use client";
import type { DailyReport } from "./shared";
import Link from "next/link";
// 2026-11-05 P2 批8：内联 style 清零（样式下沉 ./DailyServices.module.css）；
//   上/下线配色改由 data-status 属性选择器承载，取数/字段/文案未动。
import styles from "./DailyServices.module.css";

/** 服务状态 */
export default function DailyServices({ services }: { services: DailyReport["services"] }) {
  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">服务状态</span>
          {/* 2026-10-19 B5: 服务异常时没有出口 ✗ -> 链到健康检查(它会逐个 ping 并给延迟) ✓ */}
          <Link href="/system/health" className={"tiny " + styles.linkEnd}>健康检查详情 →</Link></div>
      <div className={styles.svcList}>
        {services.map((s) => {
          // 2026-11-05 P2 批8：状态只算一次，色点与文字共用（改前两处各写一遍三元）
          const online = s.status === "online";
          return (
            <div key={s.name} className={styles.svcItem}>
              <span className={"dot " + styles.svcDot} data-status={online ? "online" : "offline"} />
              <span className={styles.svcName}>{s.name}</span>
              <span className={styles.svcPort}>:{s.port}</span>
              <span className={styles.svcStatus} data-status={online ? "online" : "offline"}>{s.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
