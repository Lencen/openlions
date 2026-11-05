"use client";
// 2026-10-20 R6（维度审计 B9-4）：待办的来源分布 + 负责人 + 超 7 天未动。
// 解决的问题：原来只有"4 个总数 + 一条积压趋势"，看不出"这份活是谁的、从哪来、有没有烂在队列里"。
// 数据来自 /api/todo-distribution（只读 mind 库，口径写在响应的 basis 里）。
// 2026-11-04 P1 收尾：内联样式清零 —— 条形宽度改为 5% 一档的类名（.bar0…bar100），
//   因为宽度是数据驱动的，类名是「不用内联 style」下唯一诚实的表达。
import { useApi } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import styles from "../page.module.css";

export default function TodoDistribution() {
  const { data, error } = useApi<any>("/api/todo-distribution");
  if (error) return <div className="panel"><div className="panel-header"><span className="panel-title">待办构成</span></div><div className={"muted " + styles.distBody}>待办构成读取失败</div></div>;
  if (!data) return null;
  if (data.ok === false) return <div className="panel"><div className="panel-header"><span className="panel-title">待办构成</span></div><div className={"muted " + styles.distBody}>暂无数据</div></div>;

  const src: { name: string; count: number }[] = data.bySource || [];
  const max = Math.max(1, ...src.map((x) => x.count));
  const owner = data.byOwner || {};
  const total = Number(data.openTotal) || 0;

  // 条形成 5% 一档（0/5/…/100），对应 page.module.css 的 .bar0…​.bar100。
  const bucket = (count: number) => Math.round(((count / max) * 100) / 5) * 5;

  return (
    <div className="panel">
      <div className="panel-header">
        {/* 2026-10-20 R12：标题里的"未完成 57 件"与页首 hero 重复 → 标题只说明分组维度，数字只在 hero 出现一次 */}
        <span className="panel-title">待办构成（按来源与负责人）</span>
        <span className={styles.distBasis}>{data.basis}</span>
      </div>
      <div className="td-grid">
        <div className="td-col">
          <div className="td-h">按来源</div>
          {src.map((x) => (
            <div className="td-row" key={x.name}>
              <span className="td-name" title={x.name}>{x.name}</span>
              <span className="td-bar"><i className={styles["bar" + bucket(x.count)]} /></span>
              <span className="td-num">{x.count}</span>
            </div>
          ))}
        </div>
        <div className="td-col td-col-side">
          <div className="td-h">按负责人</div>
          {/* 2026-10-20 R12："需要人做 41"与页首「需要人决策 41」是同一批，删掉避免同屏两个 41 */}
          <div className="td-kv"><b>{fmtNum(owner.agent || 0)}</b> 智能体在跑</div>
          <div className={"td-kv " + (data.stale7 > 0 ? "warn" : "")}>
            <b>{fmtNum(data.stale7 || 0)}</b> 超 7 天未动
          </div>
          <div className="td-note">
            {data.stale7 > 0 ? "有活烂在队列里：超过 7 天没有任何动作。" : "没有超 7 天未动的待办。"}
          </div>
        </div>
      </div>
    </div>
  );
}
