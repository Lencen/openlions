import type { Metadata } from "next";
import "./globals.css";
import ThemeToggleLite, { THEME_PREPAINT_SCRIPT } from "./theme-toggle-lite";

export const metadata: Metadata = {
  title: "Session · Archive",
  description: "Lions-Session — All your agents' conversations, archived.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // 2026-10-22 主题名归一：archive-light → light（canonical :root 默认浅色），
    //   旧 ThemeBoot 换成统一切换器（兼容 lions-session-theme 旧 key）。
    <html lang="zh" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_PREPAINT_SCRIPT }} />
      </head>
      <body>
        {children}
        <div className="theme-fab"><ThemeToggleLite /></div>
      </body>
    </html>
  );
}
