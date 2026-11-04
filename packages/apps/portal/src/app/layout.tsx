import "./globals.css";
import PortalNav from "@/components/PortalNav";
import ThemeToggleLite, { THEME_PREPAINT_SCRIPT } from "@/components/ThemeToggleLite";
import type { ReactNode } from "react";

export const metadata = {
  title: "LIONS Portal — AI 接入层",
  description: "LIONS 平台对外接入门户: 注册 / 认证 / 统一知识查询",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // 2026-09-01: Portal 沿用 console P2 专业亮色主题, 保持平台视觉一致
  return (
    // 2026-10-22 主题名归一：console-light → light（canonical 的 :root 默认即浅色），
    //   并注入防闪烁脚本 + 统一切换器，让 portal 与 console/session 用同一套 light|dark|hc。
    <html lang="zh" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_PREPAINT_SCRIPT }} />
      </head>
      <body>
        <PortalNav />
        <div className="layout">{children}</div>
        <div className="theme-fab"><ThemeToggleLite /></div>
      </body>
    </html>
  );
}
