import "./globals.css";
import { ConfigProvider } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import TopNav from "@/components/TopNav";
import CommandPalette from "@/components/CommandPalette";
// Phase1 S3 (2026-09-18 agent-d): 三主题切换 + 防 FOUC 预置脚本
import ThemeToggle, { THEME_PREPAINT_SCRIPT } from "@/components/ThemeToggle";
import { CHUNK_GUARD_SCRIPT } from "@/components/chunkGuardScript";
import GlobalSidebar from "@/components/GlobalSidebar";
import { GlobalFilterBar, GlobalFilterProvider } from "@/components/GlobalFilter";
import { UI_V2_ENABLED } from "@/lib/ui-flag"; // Phase2 灰度开关 (2026-09-19 todo_d520eef2e516468da105)
import type { ReactNode } from "react";

// 2026-09-10 商业化改版: 统一外壳 = 品牌栏 + 全局筛选栏 + 分组侧边导航
// 主题: antd 与既有 CSS 变量共用同一套色板 (主色 #2563eb / 圆角 8 / 字号 13)
// Phase0.5 (2026-09-17) 主题命名统一: data-theme 取值收敛为三值语义 dark|light|hc,
//   原 console-light -> light (全仓库仅此一处引用, globals.css 无 [data-theme] 选择器, 视觉零变化)。
//   后续三主题切换: 在 globals.css 增加 [data-theme="dark"] / [data-theme="hc"] 变量覆盖块即可。
// Phase1 S3 (2026-09-18, todo_043bc321c207451089cd): **dark-first** + prefers-color-scheme 跟随
//   - data-theme 默认 dark(由 ThemeToggle 的 THEME_PREPAINT_SCRIPT 在首帧前按
//     localStorage / matchMedia 决定实际值, 此处的默认只是脚本未跑时的兜底)。
//   - 老用户首屏跟随系统偏好; 显式选择存 localStorage 并始终生效(用户优先)。
// Phase2 (2026-09-19, todo_d520eef2e516468da105): **UI_V2 灰度消费点** —— 把 NEXT_PUBLIC_UI_V2 编译期常量
//   写到 <html data-ui-v2="0|1">, 让 acceptance gate (ui-refactor-gate.cjs 的 ui-v2-consumed 项) 能从 HTML 上
//   自动验证灰度开关在 shell 层被消费。OFF 时页面与改动前一致; ON 时 workbench 屏02 切到紧凑驾驶舱。
// 2026-10-22 a11y：layout 原为 client 组件，导致无法导出 metadata → 页面没有 <title>
//   （axe serious: document-title）。这里改回 server 组件（文件内无 hooks），补 metadata。
export const metadata = {
  title: "LIONS Console — 平台管理台",
  description: "平台管理台：一屏一个决定，数据全部来自真实库。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh" data-theme="dark" data-ui-v2={UI_V2_ENABLED ? "1" : "0"} suppressHydrationWarning>
      <body>
        {/* 防 FOUC: 首帧前按 localStorage / prefers-color-scheme 设好 data-theme
            (内联脚本, 不依赖 React 挂载; 见 ThemeToggle.tsx THEME_PREPAINT_SCRIPT) */}
        <script dangerouslySetInnerHTML={{ __html: THEME_PREPAINT_SCRIPT }} />
        {/* 2026-10-13 round 76-CR: 脚本(chunk)加载失败的全局兜底。
            必须是**内联脚本**: chunk 挂了时连 layout 的 JS 都拿不到, React 组件永远不会挂载(实测验证)。 */}
        <script dangerouslySetInnerHTML={{ __html: CHUNK_GUARD_SCRIPT }} />
        {/* 主题切换(右上角浮动; 不侵入 TopNav, 待 Phase2 壳层替换时并入导航) */}
        <div style={{ position: "fixed", top: 8, right: 12, zIndex: 9999 }}>
          <ThemeToggle />
        </div>
        {/* 2026-10-13 round 76-CG: 这里原来挂着一大块 antd 风格的 theme={{token,components}}(33 行, 含 ~15 个旧调色板 hex)。
            但 ConfigProvider 是**自研直通壳**(@/components/primitives), 它的注释写明"locale/theme 显式接受并**忽略**"
            —— 即这 33 行**从来不生效**。留着它只会让人以为主色是 #2563eb(实际是令牌 --primary, 已是品牌青)。
            故删掉死配置, 只保留直通壳。 */}
        <ConfigProvider>
          <GlobalFilterProvider>
            <TopNav />
            <GlobalFilterBar />
            <GlobalSidebar />
            {children}
            {/* 2026-10-22：全站唯一 ⌘K 入口（此前 GlobalSearch 与 MessagesLayout 各监听一次，互相抢焦点） */}
            <CommandPalette />
          </GlobalFilterProvider>
        </ConfigProvider>
      </body>
    </html>
  );
}
