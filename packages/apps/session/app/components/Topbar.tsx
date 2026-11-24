import Link from "next/link";
// 2026-10-22：移除自带的 DARK/LIGHT 切换器——平台已统一成 layout 里的三主题切换器
//   （同一份实现，light|dark|hc），避免页面上出现两个互相打架的开关。
// import ThemeSwitcher from "./ThemeSwitcher";

interface TopbarProps {
  active: "overview" | "sessions" | "groups" | "tasks" | "logs" | "detail" | "search";
  crumb?: React.ReactNode;
  stats?: React.ReactNode;
}

export default function Topbar({ active, crumb, stats }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        Session<span className="dot">·</span>Archive
      </div>
      {crumb ? <div className="crumb">{crumb}</div> : null}
      {/* 0.6.5（设计 07:03 验收发现「双导航」）：U-39x 换侧栏（SessionSidebar）后，本顶栏的 6 个链接
          与侧栏重复（/groups /tasks /logs /search 四个 href 在两处同时出现），且中英混杂
          （顶栏 Overview/Sessions/Groups/Search，侧栏 会话/分组/定时任务/日志）。
          裁定（设计）：**保留侧栏，顶栏降级为无链接品牌条** —— 品牌 + 面包屑 + 右侧统计保留。
          导航职责唯一归 SessionSidebar；本组件不再输出任何 a[href]。
          active 参数保留以兼容 9 个调用方（不再用于高亮；高亮由侧栏 data-active 负责）。 */}
      <div className="topbar-spacer" />
      <div className="right">
        {stats ? <span className="stats">{stats}</span> : null}
        {/* 见文件头注释：切换器已上移到 layout */}
      </div>
    </header>
  );
}
