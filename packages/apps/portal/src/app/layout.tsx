import "./globals.css";
import "./sidebar.css";
import PortalNav from "@/components/PortalNav";
import ThemeToggleLite, { THEME_PREPAINT_SCRIPT } from "@/components/ThemeToggleLite";
import type { ReactNode } from "react";

export const metadata = {
  title: "LIONS Portal — AI 接入层",
  description: "LIONS 平台对外接入门户: 注册 / 认证 / 统一知识查询",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_PREPAINT_SCRIPT }} />
      </head>
      <body>
        {/* 0.6.4 U-39x：三应用统一导航——portal 加侧栏（页面内容不动） */}
        <div className="app-shell">
          <PortalNav />
          <main className="main">{children}</main>
        </div>
        <div className="theme-fab"><ThemeToggleLite /></div>
      </body>
    </html>
  );
}
