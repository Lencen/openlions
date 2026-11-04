"use client";

/**
 * Lions-Mind 侧边栏 + 顶栏 (Cognitive OS)
 *  - 4 主题切换 (顶栏右上)
 *  - 统一时钟 (顶栏)
 *  - 7 路由分组: CORE / MEMORY / DELIVERY / PIPELINE
 *  - 业务徽章 (KPI 数字) — 后面阶段接
 *  - active 状态: 左侧青绿色条 + 文字青绿 + 浅底
 */

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  DashboardOutlined,
  ReadOutlined,
  BulbOutlined,
  BookOutlined,
  ExperimentOutlined,
  ToolOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
  SyncOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { ConfigProvider, theme as antTheme } from "antd";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { BeijingClock } from "@lions/ui";
import { BigNumber } from "@lions/ui";

interface MenuItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  group: "CORE" | "MEMORY" | "DELIVERY" | "PIPELINE";
  badge?: number;
}

const menuItems: MenuItem[] = [
  { key: "/", icon: <DashboardOutlined />, label: "总览", group: "CORE" },
  { key: "/learning", icon: <ReadOutlined />, label: "学习", group: "MEMORY" },
  { key: "/memory", icon: <BulbOutlined />, label: "记忆", group: "MEMORY" },
  { key: "/knowledge", icon: <BookOutlined />, label: "知识", group: "MEMORY" },
  { key: "/reflection", icon: <ExperimentOutlined />, label: "反思", group: "CORE" },
  { key: "/skills", icon: <ToolOutlined />, label: "技能", group: "DELIVERY" },
  { key: "/practice", icon: <ThunderboltOutlined />, label: "实践", group: "DELIVERY" },
  { key: "/portfolio", icon: <TrophyOutlined />, label: "成果", group: "DELIVERY" },
  { key: "/flywheel", icon: <SyncOutlined />, label: "认知飞轮", group: "CORE" },
  { key: "/pipeline", icon: <ClockCircleOutlined />, label: "会话提取", group: "PIPELINE" },
  { key: "/rotation", icon: <SyncOutlined />, label: "自动任务", group: "PIPELINE" },
  { key: "/session-registry", icon: <DatabaseOutlined />, label: "Session", group: "PIPELINE" },
];

const GROUP_LABEL: Record<string, string> = {
  CORE: "CORE",
  MEMORY: "MEMORY",
  DELIVERY: "DELIVERY",
  PIPELINE: "PIPELINE",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 按 group 分组
  const groupedItems: Record<string, MenuItem[]> = {};
  for (const item of menuItems) {
    if (!groupedItems[item.group]) groupedItems[item.group] = [];
    groupedItems[item.group].push(item);
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: antTheme.darkAlgorithm,
        token: {
          colorPrimary: "#5eead4",       // 业务主色: 青绿
          borderRadius: 10,
          colorBgContainer: "var(--bg-elevated)",
          colorBgElevated: "var(--surface-hi)",
          colorText: "var(--ink-primary)",
          colorTextSecondary: "var(--ink-tertiary)",
          colorBorder: "var(--border-hi)",
          colorBgLayout: "var(--bg-base)",
          colorBgSpotlight: "var(--surface-hi)",
        },
      }}
    >
      <div
        style={{
          display: "flex",
          minHeight: "100vh",
          background: "var(--bg-base)",
          color: "var(--ink-primary)",
          fontFamily: "var(--font-body)",
        }}
      >
        {/* ============ 侧边栏 ============ */}
        <aside
          style={{
            width: collapsed ? 64 : 220,
            background: "var(--bg-base)",
            borderRight: "1px solid var(--border-hi)",
            transition: "width 0.2s var(--ease-out)",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            position: "sticky",
            top: 0,
            height: "100vh",
          }}
        >
          {/* Logo */}
          <div
            onClick={() => setCollapsed(!collapsed)}
            style={{
              padding: collapsed ? "18px 8px" : "20px 18px",
              borderBottom: "1px solid var(--border-hi)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: 64,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--gradient-mind)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
                fontWeight: 800,
                color: "var(--ink-inverse)",
                flexShrink: 0,
                boxShadow: "var(--glow-mind)",
              }}
            >
              L
            </div>
            {!collapsed && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--ink-primary)",
                    letterSpacing: -0.2,
                    lineHeight: 1.2,
                  }}
                >
                  Lions <span style={{ color: "var(--brand-mind)" }}>Mind</span>
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--ink-dim)",
                    letterSpacing: 1.5,
                    textTransform: "uppercase",
                    marginTop: 2,
                  }}
                >
                  COGNITIVE OS
                </div>
              </div>
            )}
          </div>

          {/* 菜单分组 */}
          <nav style={{ flex: 1, padding: "8px 0", overflowY: "auto" }}>
            {Object.entries(groupedItems).map(([group, items]) => (
              <div key={group} style={{ marginBottom: 8 }}>
                {!collapsed && (
                  <div
                    style={{
                      padding: "8px 18px 4px",
                      fontSize: 10,
                      color: "var(--ink-dim)",
                      letterSpacing: 1.5,
                      fontWeight: 600,
                      textTransform: "uppercase",
                    }}
                  >
                    {GROUP_LABEL[group]}
                  </div>
                )}
                {items.map((item) => {
                  const active = pathname === item.key;
                  return (
                    <div
                      key={item.key}
                      onClick={() => router.push(item.key)}
                      title={collapsed ? item.label : undefined}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: collapsed ? "10px 0" : "10px 18px",
                        cursor: "pointer",
                        color: active ? "var(--brand-mind)" : "var(--ink-tertiary)",
                        background: active ? "rgba(94, 234, 212, 0.08)" : "transparent",
                        borderLeft: `3px solid ${active ? "var(--brand-mind)" : "transparent"}`,
                        justifyContent: collapsed ? "center" : "flex-start",
                        transition: "all 0.15s var(--ease-out)",
                        fontSize: 14,
                        fontWeight: active ? 600 : 500,
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          (e.currentTarget as HTMLDivElement).style.background = "var(--surface)";
                          (e.currentTarget as HTMLDivElement).style.color = "var(--ink-primary)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          (e.currentTarget as HTMLDivElement).style.background = "transparent";
                          (e.currentTarget as HTMLDivElement).style.color = "var(--ink-tertiary)";
                        }
                      }}
                    >
                      <span style={{ fontSize: 16, display: "inline-flex" }}>{item.icon}</span>
                      {!collapsed && <span>{item.label}</span>}
                      {!collapsed && item.badge !== undefined && (
                        <span
                          style={{
                            marginLeft: "auto",
                            fontSize: 11,
                            fontWeight: 600,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "var(--surface-hi)",
                            color: "var(--ink-tertiary)",
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* 底部: 时钟 + 服务状态 */}
          {!collapsed && (
            <div
              style={{
                padding: "10px 18px",
                borderTop: "1px solid var(--border-hi)",
                fontSize: 11,
                color: "var(--ink-dim)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span className="pulse-dot" />
                <span style={{ color: "var(--status-ok)" }}>MIND ONLINE</span>
              </div>
              <BeijingClock format="time" size="sm" />
            </div>
          )}
        </aside>

        {/* ============ 主区 (顶栏 + 内容) ============ */}
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--bg-base)",
          }}
        >
          {/* 顶栏 */}
          <header
            style={{
              height: 64,
              borderBottom: "1px solid var(--border-hi)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 24px",
              background: "var(--bg-base)",
              position: "sticky",
              top: 0,
              zIndex: 10,
              backdropFilter: "blur(8px)",
            }}
          >
            {/* 左侧: 面包屑 */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-dim)",
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                }}
              >
                LIONS MIND
              </div>
              <div style={{ color: "var(--ink-dim)" }}>·</div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--ink-primary)",
                }}
              >
                {pathname === "/" ? "总览" : pathname.slice(1).split("/")[0] || ""}
              </div>
            </div>

            {/* 右侧: 时钟 + 主题切换 */}
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <BeijingClock format="time" size="md" />
              <div
                style={{
                  width: 1,
                  height: 20,
                  background: "var(--border-hi)",
                }}
              />
              <ThemeSwitcher />
            </div>
          </header>

          {/* 内容 */}
          <div style={{ flex: 1, overflow: "auto", padding: 24 }}>{children}</div>
        </main>
      </div>
    </ConfigProvider>
  );
}
