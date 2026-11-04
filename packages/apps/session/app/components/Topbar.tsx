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
      <nav>
        <Link href="/" className={active === "overview" ? "active" : ""}>Overview</Link>
        <Link href="/sessions" className={active === "sessions" ? "active" : ""}>Sessions</Link>
        <Link href="/groups" className={active === "groups" ? "active" : ""}>Groups</Link>
        <Link href="/tasks" className={active === "tasks" ? "active" : ""}>定时任务</Link>
        <Link href="/logs" className={active === "logs" ? "active" : ""}>日志</Link>
        <Link href="/search" className={active === "search" ? "active" : ""}>Search</Link>
      </nav>
      <div className="right">
        {stats ? <span className="stats">{stats}</span> : null}
        {/* 见文件头注释：切换器已上移到 layout */}
      </div>
    </header>
  );
}
