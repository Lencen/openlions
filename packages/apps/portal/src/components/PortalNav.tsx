"use client";
/**
 * PortalNav —— portal 应用统一导航侧栏（0.6.4 U-39x，方案 X）
 * 依据：[internal-doc]
 * 只统一导航壳；视觉全抄 console（240/220/64 + padL 12 + 项高 36 + 组标题 + 1024 仅图标）
 * 分组：门户（首页/Docs/Guide/Knowledge）+ 接入（Agents/Client/Report/Register）
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const GROUPS: Array<{ id: string; label: string; items: Array<{ href: string; label: string }> }> = [
  {
    id: "portal",
    label: "门户",
    items: [
      { href: "/", label: "首页" },
      { href: "/docs", label: "文档" },
      { href: "/guide", label: "指南" },
      { href: "/knowledge", label: "知识" },
    ],
  },
  {
    id: "onboard",
    label: "接入",
    items: [
      { href: "/agents", label: "智能体" },
      { href: "/client", label: "客户端" },
      { href: "/report", label: "报告" },
      { href: "/register", label: "注册" },
    ],
  },
];

export default function PortalNav() {
  const pathname = usePathname() || "/";
  return (
    <aside className="sidebar sidebar-nav">
      <div className="sidebar-brand">LIONS Portal</div>
      <nav aria-label="门户导航">
        {GROUPS.map((g) => (
          <div key={g.id} className="sidebar-group">
            <div className="nav-group-label">{g.label}</div>
            {g.items.map((it) => {
              const active = pathname === it.href || (it.href !== "/" && pathname.startsWith(it.href + "/"));
              return (
                <Link key={it.href} href={it.href} className="nav-item-label" data-active={active ? "true" : undefined} aria-current={active ? "page" : undefined}>
                  <span className="nav-item-text">{it.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="row"><span className="dot" data-tone="ok" /><span>AI 接入层 · 实时</span></div>
        <div className="row"><span className="dot" data-tone="primary" /><span>LIONS Portal</span></div>
      </div>
    </aside>
  );
}
