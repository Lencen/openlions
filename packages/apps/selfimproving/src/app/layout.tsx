import "./globals.css";
import { Providers } from "./providers";
import { FloatingThemeSwitcher } from "@/components/FloatingThemeSwitcher";

export const metadata = { title: "Lions Task" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* 主题初始化 — 必须在 <head> 第一行, 避免 FOUC */}
        <script src="/theme-init.js" />
      </head>
      <body>
        <Providers>{children}</Providers>
        {/* 跨页面浮动主题切换器(dashboard / tasks / problems / reviews / tasks/[id] 等) */}
        <FloatingThemeSwitcher />
      </body>
    </html>
  );
}
