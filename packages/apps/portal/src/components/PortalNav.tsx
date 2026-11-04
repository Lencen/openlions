"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "平台总览", color: "var(--module-core)" },
  { href: "/agents", label: "Agent 生态", color: "var(--module-extension)" },
  { href: "/guide", label: "接入手册", color: "var(--module-core)" },
  { href: "/register", label: "Agent 注册", color: "var(--module-extension)" },
  { href: "/client", label: "客户端下载", color: "var(--module-builtin)" },
  { href: "/docs", label: "API 参考", color: "var(--module-settings)" },
];

export default function PortalNav() {
  const pathname = usePathname();
  return (
    <nav className="topnav">
      <Link href="/" className="topnav-logo" style={{ textDecoration: "none" }}>
        <span className="logo-icon" />
        <span className="logo-text">LIONS Portal</span>
      </Link>
      <div className="topnav-tabs">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={"topnav-tab" + (pathname === t.href ? " active" : "")}
            style={{ "--tab-color": t.color } as React.CSSProperties}
          >
            <span className="tab-dot" style={{ background: t.color }} />
            {t.label}
          </Link>
        ))}
      </div>
      <div className="topnav-right">
        <span className="pulse-dot" style={{ background: "var(--status-ok)" }} />
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>AI 接入层 · 实时</span>
      </div>
    </nav>
  );
}
