"use client";

export const dynamic = "force-dynamic";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ListPagination } from "@lions/ui";

const UTC8_OFFSET = 8 * 60 * 60 * 1000;
const toBeijingTime = (iso: string) => new Date(new Date(iso).getTime() + UTC8_OFFSET);
const formatBeijingDate = (date: Date) => {
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${m}-${d}`;
};

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
    background: linear-gradient(135deg, rgba(239,68,68,0.1) 0%, rgba(245,158,11,0.05) 100%);
    border: 1px solid rgba(239,68,68,0.3);
    border-radius: 12px;
  }

  .header h1 {
    font-size: 20px;
    font-weight: 700;
    color: var(--status-err);
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
    border-color: var(--status-err);
    color: var(--status-err);
  }

  .filter-btn.active {
    background: rgba(239,68,68,0.15);
    border-color: var(--status-err);
    color: var(--status-err);
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
    grid-template-columns: 40px 1fr 60px 80px 80px 100px;
    gap: 8px;
    padding: 12px 16px;
    background: rgba(239,68,68,0.1);
    border-bottom: 1px solid ${THEME.colors.border};
    font-size: 11px;
    font-weight: 600;
    color: var(--status-err);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .table-row {
    display: grid;
    grid-template-columns: 40px 1fr 60px 80px 80px 100px;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    align-items: center;
    transition: background 0.2s;
  }

  .table-row:hover {
    background: rgba(239,68,68,0.05);
  }

  .table-row:last-child {
    border-bottom: none;
  }

  .problem-title {
    font-size: 13px;
    font-weight: 500;
    color: ${THEME.colors.text};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .problem-source {
    font-size: 11px;
    color: ${THEME.colors.textMuted};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 2px;
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

  .back-btn {
    padding: 8px 16px;
    background: transparent;
    border: 1px solid ${THEME.colors.border};
    color: ${THEME.colors.textMuted};
    border-radius: 6px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;
  }

  .back-btn:hover {
    border-color: ${THEME.colors.primary};
    color: ${THEME.colors.primary};
  }

  @media (max-width: 900px) {
    .table-header, .table-row {
      grid-template-columns: 40px 1fr 60px 80px 100px;
    }
    .table-header > *:nth-child(5),
    .table-row > *:nth-child(5) {
      display: none;
    }
    .kpi-row {
      grid-template-columns: repeat(2, 1fr) !important;
    }
  }

  @media (max-width: 600px) {
    .page { padding: 16px !important; }
    .table-header, .table-row {
      grid-template-columns: 40px 1fr 60px;
      font-size: 11px;
    }
    .table-header > *:nth-child(4),
    .table-row > *:nth-child(4),
    .table-header > *:nth-child(5),
    .table-row > *:nth-child(5),
    .table-header > *:nth-child(6),
    .table-row > *:nth-child(6) {
      display: none;
    }
    .kpi-row {
      grid-template-columns: repeat(2, 1fr) !important;
    }
    .header {
      flex-direction: column;
      align-items: flex-start !important;
      gap: 12px;
    }
    .filter-row {
      gap: 4px !important;
    }
    .filter-btn {
      font-size: 11px !important;
      padding: 4px 10px !important;
    }
  }
`;

const SEVERITY_COLORS: Record<string, string> = {
  P1: "var(--status-err)",
  P2: "var(--status-warn)",
  P3: "var(--brand-mind)",
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: "var(--status-err)",
  SOLVING: "var(--status-warn)",
  SOLVED: "var(--status-ok)",
  ABANDONED: "var(--ink-tertiary)",
};

interface Problem {
  id: string;
  description: string;
  severity: string;
  status: string;
  taskId: string;
  taskExecution?: { task?: { title: string } };
  resolvedAt?: string;
  autoResolveAttempts: number;
  solutionsAttempted?: string;
  createdAt: string;
}

interface ProblemListData {
  items: Problem[];
  total: number;
}

interface DashboardStats {
  problemStats: Array<{ _count: number; status: string }>;
}

export default function ProblemsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [severityFilter, setSeverityFilter] = useState<string>("");

  // 获取统计数据
  const { data: statsData } = useQuery<DashboardStats>({
    queryKey: ["dashboard", "overview"],
    queryFn: () =>
      fetch("/api/trpc/dashboard.overview")
        .then((r) => r.json())
        .then((r) => r.result.data),
  });

  // P1-7 统一分页
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  // 获取问题列表
  const { data, isLoading } = useQuery<ProblemListData>({
    queryKey: ["problem", "list", statusFilter, severityFilter, page, pageSize],
    queryFn: () => {
      const params: Record<string, string | number> = { page, pageSize };
      if (statusFilter) params.status = statusFilter;
      if (severityFilter) params.severity = severityFilter;
      return fetch(`/api/trpc/problem.list?input=${encodeURIComponent(JSON.stringify(params))}`)
        .then((r) => r.json())
        .then((r) => r.result.data);
    },
  });

  // 统计各状态数量
  const problemMap: Record<string, number> = {};
  statsData?.problemStats.forEach((p) => { problemMap[p.status] = p._count; });
  const totalProblems = Object.values(problemMap).reduce((a, b) => a + b, 0);

  const statusFilters = [
    { value: "", label: "全部" },
    { value: "OPEN", label: "待解决" },
    { value: "SOLVING", label: "处理中" },
    { value: "SOLVED", label: "已解决" },
    { value: "ABANDONED", label: "已废弃" },
  ];

  const severityFilters = [
    { value: "", label: "全部" },
    { value: "P1", label: "P1 严重" },
    { value: "P2", label: "P2 中等" },
    { value: "P3", label: "P3 一般" },
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
          <h1>⚠️ 问题管理中心</h1>
          <Link href="/tasks">
            <button className="back-btn">← 任务列表</button>
          </Link>
        </div>

        {/* KPI 统计 */}
        <div className="section-title">📊 问题统计</div>
        <div className="kpi-row">
          <div className="kpi-card" style={{ borderColor: "rgba(102,126,234,0.3)" }}>
            <div className="kpi-label">总计</div>
            <div className="kpi-value" style={{ color: "var(--ink-primary)" }}>{totalProblems}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.OPEN}40` }}>
            <div className="kpi-label">待解决</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.OPEN }}>{problemMap.OPEN ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.SOLVING}40` }}>
            <div className="kpi-label">处理中</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.SOLVING }}>{problemMap.SOLVING ?? 0}</div>
          </div>
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.SOLVED}40` }}>
            <div className="kpi-label">已解决</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.SOLVED }}>{problemMap.SOLVED ?? 0}</div>
          </div>
          {/* P2-10 修复: 漏渲染"已废弃" KPI 卡片(虽然 statusFilters 有 ABANDONED, KPI 区域没显示) */}
          <div className="kpi-card" style={{ borderColor: `${STATUS_COLORS.ABANDONED}40` }}>
            <div className="kpi-label">已废弃</div>
            <div className="kpi-value" style={{ color: STATUS_COLORS.ABANDONED }}>{problemMap.ABANDONED ?? 0}</div>
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
            <span style={{ fontSize: 11, color: "var(--ink-tertiary)", marginRight: 8, alignSelf: "center" }}>严重度:</span>
            {severityFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setSeverityFilter(f.value)}
                className={`filter-btn ${severityFilter === f.value ? "active" : ""}`}
                style={severityFilter === f.value ? {
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
        </div>

        {/* 表格 */}
        <div className="table-container">
          <div className="table-header">
            <span>#</span>
            <span>问题描述</span>
            <span>严重度</span>
            <span>状态</span>
            <span>自动解析</span>
            <span>时间</span>
          </div>
          {isLoading ? (
            <div className="empty">加载中...</div>
          ) : data?.items && data.items.length > 0 ? (
            data.items.map((problem, idx) => (
              <Link key={problem.id} href={`/problems/${problem.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="table-row">
                  <span style={{ color: "var(--ink-tertiary)" }}>{idx + 1}</span>
                  <div>
                    <div className="problem-title">{problem.description}</div>
                    <div className="problem-source">
                      来自: {problem.taskExecution?.task?.title || problem.taskId.slice(0, 8)}…
                    </div>
                  </div>
                  <span className="badge" style={{ background: SEVERITY_COLORS[problem.severity] || "var(--ink-tertiary)", color: "var(--ink-primary)" }}>
                    {problem.severity}
                  </span>
                  <span className="badge" style={{ background: STATUS_COLORS[problem.status] || "var(--ink-tertiary)", color: "var(--ink-primary)" }}>
                    {problem.status}
                  </span>
                  <span style={{ color: "var(--status-warn)", fontSize: 11 }}>
                    {problem.autoResolveAttempts > 0 ? `${problem.autoResolveAttempts}次` : "-"}
                  </span>
                  <span className="time">
                    {formatBeijingDate(toBeijingTime(problem.createdAt))}
                  </span>
                </div>
              </Link>
            ))
          ) : (
            <div className="empty">暂无问题记录</div>
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
            noun="个问题"
            palette="cyan"
          />
        )}
      </div>
    </>
  );
}