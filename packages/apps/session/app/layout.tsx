import type { Metadata } from "next";
import "./globals.css";
import "./sidebar.css";
import SessionSidebar from "./components/SessionSidebar";
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
        {/* 0.6.4 U-39x：三应用统一导航——session 加侧栏（页面内容不动） */}
        <div className="app-shell">
          <SessionSidebar />
          {/* 0.6.5 收口（运营团队 07:53）：原为 <main className="main">，但每页自身已有
              <main className="page ...">（承载 data-phase）—— 嵌套 <main> 违反"一页一个 main"，
              屏幕阅读器会把内容读两遍。改为 <div>：保留 .main 布局类（sidebar.css:38 flex:1），
              页面级 <main> 成为唯一 landmark。 */}
          <div className="main">{children}</div>
        </div>
        <div className="theme-fab"><ThemeToggleLite /></div>
      </body>
    </html>
  );
}
