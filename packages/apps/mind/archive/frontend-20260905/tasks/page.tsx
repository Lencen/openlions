"use client";

export const dynamic = "force-dynamic";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ListPagination } from "@lions/ui";

// ============ 工具函数 ============
const UTC8_OFFSET = 8 * 60 * 60 * 1000;
const toBeijingTime = (iso: string) => new Date(new Date(iso).getTime() + UTC8_OFFSET);
const formatBeijingDate = (date: Date) => {
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${m}-${d}`;
};

// ============ 主题配置 ============
const THEME = {
  colors: {
    primary: "var(--brand-mind)",
    secondary: "var(--brand-synapse)",
    background: "var(--bg-base)",
    surface: "rgba(255,255,255,0.05)",
    border: "rgba(0,212,255,0.3)",
    text: "var(--ink-primary)",
    textMuted: "var(--ink-tertiary)",
    success: "var(--status-ok)",
    warning: "var(--status-warn)",
    error: "var(--status-err)",
  },
};

// ============ 样式 ============
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: ${THEME.colors.background};
    color: ${THEME.colors.text};
    font-family: 'Rajdhani', sans-serif;
    min-height: 100vh;
  }

  .page { max-width: 1400px; margin: 0 auto; padding: 20px; }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding: 16px 20px;
    background: linear-gradient(135deg, rgba(0,212,255,0.1) 0%, rgba(168,85,247,0.05) 100%);
    border: 1px solid ${THEME.colors.border};
    border-radius: 12px;
  }

  .header h1 {
    font-size: 20px;
    font-weight: 700;
    color: ${THEME.colors.primary};
    letter-spacing: 2px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    color: ${THEME.colors.primary};
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 12px;
    padding-left: 8px;
    border-left: 3px solid ${THEME.colors.primary};
  }

  .kpi-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }

  .kpi-card {
    background: ${THEME.colors.surface};
    border: 1px solid ${THEME.colors.border};
    border-radius: 10px;
    padding: 14px 16px;
    text-align: center;
    backdrop-filter: blur(10px);
    position: relative;
    overflow: hidden;
  }

  .kpi-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
  }

  .kpi-label {
    font-size: 11px;
    color: ${THEME.colors.textMuted};
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 6px;
  }

  .kpi-value {
    font-size: 28px;
    font-weight: 700;
  }

  .filter-row {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .filter-btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid ${THEME.colors.border};
    background: transparent;
    color: ${THEME.colors.textMuted};
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;
  }

  .filter-btn:hover {
    border-color: ${THEME.colors.primary};
    color: ${THEME.colors.primary};
  }

  .filter-btn.active {
    background: rgba(0,212,255,0.15);
    border-color: ${THEME.colors.primary};
    color: ${THEME.colors.primary};
  }

  .table-container {
    background: ${THEME.colors.surface};
    border: 1px solid ${THEME.colors.border};
    border-radius: 10px;
    overflow: hidden;
    backdrop-filter: blur(10px);
  }

  .table-header {
    display: grid;
    grid-template-columns: 40px minmax(0, 1.6fr) 70px 110px 60px 60px 100px;
    gap: 8px;
    padding: 12px 16px;
    background: rgba(0,212,255,0.1);
    border-bottom: 1px solid ${THEME.colors.border};
    font-size: 11px;
    font-weight: 600;
    color: ${THEME.colors.primary};
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .table-row {
    display: grid;
    grid-template-columns: 40px minmax(0, 1.6fr) 70px 110px 60px 60px 100px;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    align-items: center;
    transition: background 0.2s;
    min-width: 0;
  }

  .table-row:hover {
    background: rgba(0,212,255,0.05);
  }

  .table-row:last-child {
    border-bottom: none;
  }

  .task-title {
    font-size: 13px;
    font-weight: 500;
    color: ${THEME.colors.text};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .task-desc {
    font-size: 11px;
    color: ${THEME.colors.textMuted};
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    margin-top: 2px;
    min-width: 0;
    word-break: break-word;
  }

  .task-cell {
    min-width: 0;
    overflow: hidden;
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .time {
    font-size: 11px;
    color: ${THEME.colors.textMuted};
  }

  .empty {
    text-align: center;
    padding: 48px;
    color: ${THEME.colors.textMuted};
  }

  .new-btn {
    padding: 8px 20px;
    background: ${THEME.colors.primary};
    color: var(--bg-base);
    border: none;
    border-radius: 6px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }

  @media (max-width: 900px) {
    .table-header, .table-row {
      grid-template-columns: 40px minmax(0, 1.6fr) 70px 110px 100px;
    }
    .table-header > *:nth-child(5),
    .table-header > *:nth-child(6),
    .table-row > *:nth-child(5),
    .table-row > *:nth-child(6) {
      display: none;
    }
  }
`;

const STATUS_COLORS: Record<string, string> = {
  PENDING: "var(--status-warn)",
  IN_PROGRESS: "var(--brand-mind)",
  REVIEW: "var(--brand-synapse)",
  COMPLETED: "var(--status-ok)",
  FAILED: "var(--status-err)",
  BLOCKED: "var(--status-warn)",
  DEPRECATED: "var(--ink-tertiary)",
  CANCELLED: "var(--ink-tertiary)",
};

const PRIORITY_COLORS: Record<string, string> = {
  P1: "var(--status-err)",
  P2: "var(--status-warn)",
  P3: "var(--brand-mind)",
};

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  estimatedEffort?: string;
  executions: any[];
  reviews: any[];
  createdAt: string;
}

interface TaskListData {
  items: Task[];
  total: number;
}

interface DashboardStats {
  taskStats: Array<{ _count: number; status: string }>;
}

export default function TasksPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [timeFilter, setTimeFilter] = useState<string>("all"); // all, 1h, 24h, 7d, 30d
  const [page, setPage] = useState(1); // P3 修复: 加分页
  const [pageSize, setPageSize] = useState(50); // P1-7: 用户可切换 20/50/100/200

  // 获取统计数据
  const { data: statsData } = useQuery<DashboardStats>({
    queryKey: ["dashboard", "overview"],
    queryFn: () =>
      fetch("/api/trpc/dashboard.overview")
        .then((r) => r.json())
        .then((r) => r.result.data),
  });

  // 获取任务列表
  const { data, isLoading } = useQuery<TaskListData>({
    queryKey: ["task", "list", statusFilter, priorityFilter, timeFilter, page],
    queryFn: () => {
      const params: Record<string, string | number> = { page, pageSize };
      if (statusFilter) params.status = statusFilter;
      if (priorityFilter) params.priority = priorityFilter;
      // P2-3: 时间筛选
      if (timeFilter !== "all") {
        const now = Date.now();
        const intervals: Record<string, number> = {
          "1h": 60 * 60 * 1000,
          "24h": 24 * 60 * 60 * 1000,
          "7d": 7 * 24 * 60 * 60 * 1000,
          "30d": 30 * 24 * 60 * 60 * 1000,
        };
        const since = new Date(now - (intervals[timeFilter] || 0));
        params.createdAfter = since.toISOString();
      }
      return fetch(`/api/trpc/task.list?input=${encodeURIComponent(JSON.stringify(params))}`)
        .then((r) => r.json())
        .then((r) => r.result.data);
    },
  });

  // 统计各状态数量
  const taskMap: Record<string, number> = {};
  statsData?.taskStats.forEach((t) => { taskMap[t.status] = t._count; });
  const totalTasks = Object.values(taskMap).reduce((a, b) => a + b, 0);

  const statusFilters = [
    { value: "", label: "全部" },
    { value: "PENDING", label: "待处理" },
    { value: "IN_PROGRESS", label: "进行中" },
    { value: "REVIEW", label: "评审中" },
    { value: "COMPLETED", label: "已完成" },
    { value: "BLOCKED", label: "阻塞" },
    { value: "DEPRECATED", label: "已废弃" },
    { value: "CANCELLED", label: "已取消" },
  ];

  const priorityFilters = [
    { value: "", label: "全部" },
    { value: "P1", label: "P1 紧急" },
    { value: "P2", label: "P2 高" },
    { value: "P3", label: "P3 中" },
  ];

  const timeFilters = [
    { value: "all", label: "全部" },
    { value: "1h", label: "1小时内" },
    { value: "24h", label: "24小时内" },
    { value: "7d", label: "7天内" },
    { value: "30d", label: "30天内" },
  ];

  return (
    <>
      {/* P3 修复: 用 dangerouslySetInnerHTML 注入 CSS 避免 hydration mismatch
         原 <style>{css}</style> 在 SSR 时 React 把 css 当 text 节点, escape HTML entity
         (&#x27;, &amp;, &gt;), client hydration 时不一致, 报 hydration error
       */}
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="page">
        {/* Header */}
        <div className="header">
          <h1>◇ 任务管理中心</h1>
          <Link href="/tasks/new">
            <button className="new-btn">+ 新建任务</button>
          </Link>
        </div>

        {/* KPI 统计 */}
        <div className="section-title">📊 任务统计</div>
        <div className="kpi-row">
          <div className="kpi-card" style={{ borderColor: "rgba(102,126,234,0.3)" }}>
            <div className="kpi-label">总计</div>
            <div className="kpi-value" style={{ color: "var(--ink-primary)" }}>{totalTasks}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.PENDING}40` }}>
            <div className="kpi-label">待处理</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.PENDING }}>{taskMap.PENDING ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.IN_PROGRESS}40` }}>
            <div className="kpi-label">进行中</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.IN_PROGRESS }}>{taskMap.IN_PROGRESS ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.COMPLETED}40` }}>
            <div className="kpi-label">已完成</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.COMPLETED }}>{taskMap.COMPLETED ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.FAILED}40` }}>
            <div className="kpi-label">失败</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.FAILED }}>{taskMap.FAILED ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.BLOCKED}40` }}>
            <div className="kpi-label">阻塞</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.BLOCKED }}>{taskMap.BLOCKED ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.DEPRECATED}40` }}>
            <div className="kpi-label">已废弃</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.DEPRECATED }}>{taskMap.DEPRECATED ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.CANCELLED}40` }}>
            <div className="kpi-label">已取消</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.CANCELLED }}>{taskMap.CANCELLED ?? 0}</div>
          </div>
        </div>

        {/* 筛选器 */}
        <div style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ marginBottom: 8 }}>🔍 筛选</div>
          <div className="filter-row">
            <span style={{ fontSize: 11, color: "var(--ink-tertiary)", marginRight: 8, alignSelf: "center" }}>状态:</span>
            {statusFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`filter-btn ${statusFilter === f.value ? "active" : ""}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="filter-row">
            <span style={{ fontSize: 11, color: "var(--ink-tertiary)", marginRight: 8, alignSelf: "center" }}>优先级:</span>
            {priorityFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setPriorityFilter(f.value)}
                className={`filter-btn ${priorityFilter === f.value ? "active" : ""}`}
                style={priorityFilter === f.value ? {
                  background: f.value === "P1" ? "rgba(239,68,68,0.15)" :
                              f.value === "P2" ? "rgba(245,158,11,0.15)" :
                              f.value === "P3" ? "rgba(0,212,255,0.15)" : "rgba(239,68,68,0.15)",
                  borderColor: f.value === "P1" ? "var(--status-err)" :
                               f.value === "P2" ? "var(--status-warn)" :
                               f.value === "P3" ? "var(--brand-mind)" : "var(--status-err)",
                  color: f.value === "P1" ? "var(--status-err)" :
                         f.value === "P2" ? "var(--status-warn)" :
                         f.value === "P3" ? "var(--brand-mind)" : "var(--status-err)",
                } : {}}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="filter-row">
            <span style={{ fontSize: 11, color: "var(--ink-tertiary)", marginRight: 8, alignSelf: "center" }}>时间:</span>
            {timeFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setTimeFilter(f.value)}
                className={`filter-btn ${timeFilter === f.value ? "active" : ""}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* 表格 */}
        <div className="table-container">
          <div className="table-header">
            <span>#</span>
            <span>任务标题</span>
            <span>优先级</span>
            <span>状态</span>
            <span>执行</span>
            <span>评审</span>
            <span>时间</span>
          </div>
          {isLoading ? (
            <div className="empty">加载中...</div>
          ) : data?.items && data.items.length > 0 ? (
            data.items.map((task, idx) => (
              <Link key={task.id} href={`/tasks/${task.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="table-row">
                  <span style={{ color: "var(--ink-tertiary)" }}>{idx + 1}</span>
                  <div>
                    <div className="task-title">{task.title}</div>
                    <div className="task-desc">{task.description}</div>
                  </div>
                  <span className="badge" style={{ background: PRIORITY_COLORS[task.priority], color: "var(--ink-primary)" }}>
                    {task.priority}
                  </span>
                  <span className="badge" style={{ background: STATUS_COLORS[task.status], color: "var(--ink-primary)" }}>
                    {task.status.replace("_", " ")}
                  </span>
                  <span style={{ color: "var(--status-ok)", fontSize: 11 }}>
                    {task.executions.length > 0 ? `${task.executions.length}次` : "-"}
                  </span>
                  <span style={{ color: "var(--brand-mind)", fontSize: 11 }}>
                    {task.reviews.length > 0 ? `${task.reviews.length}次` : "-"}
                  </span>
                  <span className="time">
                    {formatBeijingDate(toBeijingTime(task.createdAt))}
                  </span>
                </div>
              </Link>
            ))
          ) : (
            <div className="empty">暂无任务</div>
          )}
        </div>
        {/* P1-7 统一分页控件 */}
        {data && data.total > 0 && (
          <ListPagination
            total={data.total}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            noun="个任务"
            palette="cyan"
          />
        )}
      </div>
    </>
  );
}