"use client";
import Link from "next/link";
import Icon from "@/components/Icon";
import { isLocked } from "@/lib/permission";
import type { Submodule } from "@/config/submodules";

export default function EntryCard({ sub }: { sub: Submodule }) {
  const locked = isLocked(sub.perm, sub.locked);
  return (
    <Link href={locked ? "#" : sub.href} className={`entry-card ${locked ? "locked" : ""}`}
      style={{ pointerEvents: locked ? "none" : "auto" }}>
      {/* 2026-10-13 round 76-DC: 原来这里内联写死 rgba(94,234,212,.1)(其实是亮色 --table-memory 的值),
          把 CSS 里 `.entry-card .card-icon { background: var(--primary-dim) }` **盖掉**了 -> 暗色/高对比下不跟随主题。
          这里直接删掉内联, 让那条已有的令牌规则生效。 */}
      <div className="card-icon"><Icon name={sub.icon} size={20} /></div>
      <div className="card-title">{sub.label}</div>
      <div className="card-desc">{sub.desc}</div>
      {sub.stats && (
        <div className="card-stats">
          {sub.stats.map(s => (
            <div key={s.label} className="card-stat">
              <span className="card-stat-label">{s.label}</span>
              <span className="card-stat-value">{s.value}</span>
            </div>
          ))}
        </div>
      )}
      {/* 2026-10-13 round 76-DG: 原来**无条件**渲染这个 span, 未锁定时它的文本是空串 ——
          于是在每张入口卡的右上角留下一个 **14×6px 的空虚线小胶囊**(实测文本为空、高 6px),
          看起来像个坏掉的小图标。改为**只在锁定(待实现)时才渲染**。 */}
      {locked ? <span className="perm-hint" title={sub.perm}>待实现</span> : null}
    </Link>
  );
}
