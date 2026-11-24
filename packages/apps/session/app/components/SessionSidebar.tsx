"use client";
/**
 * SessionSidebar —— session 应用统一导航侧栏（0.6.4 U-39x，方案 X）
 *
 * 依据：[internal-doc]
 *   · 只统一导航壳，页面内容一律不动
 *   · 视觉全抄 console（240/220/64 三档 + padL 12 + 项高 36 + 组标题 + 1024 仅图标）
 *   · 复制而非抽共享包（设计 建议，2 人日口径）
 *
 * 分组（设计 规格 §1.1）：会话（Overview/Sessions/Groups）+ 运维（Tasks/Logs/Search）
 */
import { usePathname } from "next/navigation";
import Link from "next/link";

const GROUPS: Array<{ id: string; label: string; items: Array<{ href: string; label: string }> }> = [
  {
    id: "session",
    label: "会话",
    items: [
      { href: "/", label: "Overview" },
      { href: "/sessions", label: "会话" },
      { href: "/groups", label: "分组" },
    ],
  },
  {
    id: "ops",
    label: "运维",
    items: [
      { href: "/tasks", label: "定时任务" },
      { href: "/logs", label: "日志" },
      { href: "/search", label: "搜索" },
    ],
  },
];

export default function SessionSidebar() {
  const pathname = usePathname() || "/";
  return (
    <aside className="sidebar sidebar-nav">
      <div className="sidebar-brand">Session · Archive</div>
      <nav aria-label="会话导航">
        {GROUPS.map((g) => (
          <div key={g.id} className="sidebar-group">
            <div className="nav-group-label">{g.label}</div>
            {g.items.map((it) => {
              const active = pathname === it.href || (it.href !== "/" && pathname.startsWith(it.href + "/"));
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className="nav-item-label"
                  data-active={active ? "true" : undefined}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="nav-item-text">{it.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="row"><span className="dot" data-tone="ok" /><span>会话归档</span></div>
        <div className="row"><span className="dot" data-tone="primary" /><span>LIONS Session</span></div>
      </div>
    </aside>
  );
}
