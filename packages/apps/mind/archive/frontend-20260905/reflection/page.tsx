"use client";

import { useState, useEffect } from "react";
import dayjs from "dayjs";
import { Card, Table, Tag, Select, Row, Col, Statistic, Empty, Spin, Button, Modal, Form, Input, InputNumber, message, Tabs } from "antd";
import { Constellation } from "@/components/charts/Constellation";
import { ReflectionFunnel } from "@/components/charts/ReflectionFunnel";
import { BigNumber } from "@lions/ui";
import { ExperimentOutlined, PlusOutlined, CheckCircleOutlined, CalendarOutlined } from "@ant-design/icons";
import dynamic from "next/dynamic";
const ReactECharts = dynamic(() => import("echarts-for-react/lib/core"), { ssr: false });
import * as echarts from "echarts/core";
import { FunnelChart } from "echarts/charts";
import { TooltipComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([FunnelChart, TooltipComponent, LegendComponent, CanvasRenderer]);

interface ImprovementAction {
  id: string;
  content: string;
  status: string;
  effect: string | null;
}

interface ReflectionItem {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: string;
  priority: string | null;
  score: number | null;
  lesson: string | null;
  insight: string | null;
  improvements: string | null;
  createdAt: string;
  updatedAt: string;
  improvementActions: ImprovementAction[];
  // === V3 字段(详情 expand 用,P0-6 修复)===
  sourceType: string | null;
  sourceId: string | null;
  agentSource: string | null;
  theme: string | null;
  actionType: string | null;
  actionConfidence: number | null;
  processingVersion: string | null;
  rootCauseAnalysis: string | null;
  proposedPlan: string | null;
  relatedMemoryIds: string | null;
  relatedKnowledgeIds: string | null;
  relatedSessionIds: string | null;
  relatedProblemIds: string | null;
  reinforceCount: number | null;
  supersededBy: string | null;
  __loadedDetail?: boolean;
}

interface FunnelData {
  total: number;
  withLesson: number;
  withImprovements: number;
  improvementsExecuted: number;
  withFeedback: number;
}

interface DailySummary {
  date: string;
  count: number;
  resolved: number;
  items: ReflectionItem[];
}

const reflSourceTypeLabel: Record<string, string> = {
  GLOBAL_ORGANIZER: "全局整理",
  PIPELINE_HERMES: "Hermes碎片",
  "PIPELINE_agent-h": "UT碎片",
  PIPELINE_CLAUDE: "Claude碎片",
};
const reflSourceTypeColor: Record<string, string> = {
  GLOBAL_ORGANIZER: "blue",
  PIPELINE_HERMES: "default",
  "PIPELINE_agent-h": "default",
  PIPELINE_CLAUDE: "default",
};

export default function ReflectionPage() {
  const [items, setItems] = useState<ReflectionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<ReflectionItem | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveItem, setResolveItem] = useState<ReflectionItem | null>(null);
  const [resolveInsight, setResolveInsight] = useState("");
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState("反思列表");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [calendarYear, setCalendarYear] = useState(dayjs().year());
  const [calendarMonth, setCalendarMonth] = useState(dayjs().month());

  // P1-7 统一分页
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // Group reflections by day for calendar view
  const dailySummaries: DailySummary[] = items.length > 0 ? (() => {
    const map = new Map<string, ReflectionItem[]>();
    items.forEach((r) => {
      const dateKey = new Date(r.createdAt).toISOString().split("T")[0];
      if (!map.has(dateKey)) map.set(dateKey, []);
      map.get(dateKey)!.push(r);
    });
    return Array.from(map.entries()).map(([date, dayItems]) => ({
      date,
      count: dayItems.length,
      resolved: dayItems.filter((r) => r.status === "RESOLVED" || r.status === "CLOSED" || r.status === "IN_PROGRESS").length,
      items: dayItems,
    })).sort((a, b) => b.date.localeCompare(a.date));
  })() : [];

  const selectedSummary = selectedDate ? dailySummaries.find((s) => s.date === selectedDate) : null;

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/trpc/reflection.list?input=" + encodeURIComponent(JSON.stringify({ page, pageSize, sortBy: "updatedAt", sortOrder: "desc" }))).then((r) => r.json()),
      fetch("/api/trpc/reflection.getFunnel").then((r) => r.json()),
    ])
      .then(([listJson, funnelJson]) => {
        setItems(listJson.result?.data?.items ?? []);
        setTotal(listJson.result?.data?.total ?? 0);
        setFunnel(funnelJson.result?.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, [page, pageSize]);

  const handleCreate = async (values: { title: string; description?: string; category?: string; priority?: string; lesson?: string; insight?: string; score?: number }) => {
    try {
      const res = await fetch("/api/trpc/reflection.create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.result) {
        message.success("反思已创建");
        setCreateOpen(false);
        form.resetFields();
        fetchData();
      }
    } catch {
      message.error("创建失败");
    }
  };

  const handleResolve = async () => {
    if (!resolveItem) return;
    try {
      const res = await fetch("/api/trpc/reflection.resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: resolveItem.id, insight: resolveInsight || undefined }),
      });
      const json = await res.json();
      if (json.result) {
        message.success("反思已解决，已自动沉淀为记忆");
        setResolveOpen(false);
        setResolveInsight("");
        setResolveItem(null);
        fetchData();
      }
    } catch {
      message.error("操作失败");
    }
  };

  const funnelOption = funnel && funnel.total > 0 ? {
    tooltip: { trigger: "item" as const, backgroundColor: "#1e2a4a", borderColor: "#2a3a5c", textStyle: { color: "#e8e8e8" }, formatter: (params: { name: string; value: number }) => `${params.name}: ${params.value} (${funnel.total > 0 ? Math.round(params.value / funnel.total * 100) : 0}%)` },
    series: [{
      type: "funnel",
      left: "10%",
      top: 20,
      bottom: 20,
      width: "80%",
      min: 0,
      max: funnel.total,
      minSize: "10%",
      maxSize: "100%",
      sort: "descending",
      gap: 4,
      label: { show: true, position: "inside", color: "#fff", fontSize: 13 },
      labelLine: { show: false },
      itemStyle: { borderWidth: 0 },
      data: [
        { value: funnel.total, name: "反思记录", itemStyle: { color: "#667eea" } },
        { value: funnel.withLesson, name: "有教训", itemStyle: { color: "#eb2f96" } },
        { value: funnel.withImprovements, name: "有改进措施", itemStyle: { color: "#faad14" } },
        { value: funnel.improvementsExecuted, name: "已执行", itemStyle: { color: "#52c41a" } },
        { value: funnel.withFeedback, name: "有效果反馈", itemStyle: { color: funnel.withFeedback > 0 ? "#13c2c2" : "#434343" } },
      ],
    }],
  } : null;

  const statusColor = (status: string) => {
    const map: Record<string, string> = { OPEN: "blue", IN_PROGRESS: "orange", RESOLVED: "green", CLOSED: "default" };
    return map[status] ?? "default";
  };

  const fmtTime = (v: string) => v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
  const columns = [
    { title: "标题", dataIndex: "title", key: "title", sorter: (a: ReflectionItem, b: ReflectionItem) => a.title.localeCompare(b.title), render: (v: string) => <span style={{ color: "var(--ink-primary)" }}>{v}</span> },
    { title: "来源", dataIndex: "sourceType", key: "sourceType", width: 90, sorter: (a: ReflectionItem, b: ReflectionItem) => (a.sourceType ?? "").localeCompare(b.sourceType ?? ""), render: (v: string | null) => v ? <Tag color={reflSourceTypeColor[v] ?? "default"}>{reflSourceTypeLabel[v] ?? v}</Tag> : "-" },
    { title: "主题", dataIndex: "theme", key: "theme", width: 90, ellipsis: true, render: (v: string | null) => v ? <Tag style={{ fontSize: 11 }}>{v}</Tag> : "-" },
    { title: "状态", dataIndex: "status", key: "status", width: 80, sorter: (a: ReflectionItem, b: ReflectionItem) => a.status.localeCompare(b.status), render: (v: string) => <Tag color={statusColor(v)}>{v}</Tag> },
    { title: "优先级", dataIndex: "priority", key: "priority", width: 70, sorter: (a: ReflectionItem, b: ReflectionItem) => (a.priority ?? "").localeCompare(b.priority ?? ""), render: (v: string | null) => v ? <Tag color={v === "P1" ? "red" : v === "P2" ? "orange" : "default"}>{v}</Tag> : "-" },
    { title: "评分", dataIndex: "score", key: "score", width: 55, sorter: (a: ReflectionItem, b: ReflectionItem) => (a.score ?? 0) - (b.score ?? 0), render: (v: number | null) => v ? `${v}/10` : "-" },
    { title: "创建时间", dataIndex: "createdAt", key: "createdAt", width: 120, sorter: (a: ReflectionItem, b: ReflectionItem) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(), render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", width: 120, sorter: (a: ReflectionItem, b: ReflectionItem) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(), defaultSortOrder: "descend" as const, render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
    { title: "操作", key: "action", width: 70, render: (_: unknown, record: ReflectionItem) => record.status === "OPEN" ? (
      <Button type="link" size="small" icon={<CheckCircleOutlined />} onClick={(e) => { e.stopPropagation(); setResolveItem(record); setResolveOpen(true); }} style={{ color: "var(--status-ok)", padding: 0 }}>解决</Button>
    ) : null },
  ];

  const filtered = items.filter((r) => (!statusFilter || r.status === statusFilter) && (!sourceTypeFilter || r.sourceType === sourceTypeFilter));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: "var(--ink-primary)" }}><ExperimentOutlined style={{ marginRight: 8 }} />反思</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建反思</Button>
      </div>

      {/* ============ 阶段 4 新增: Hero + 5 段漏斗 + 主题星云 (Cognitive OS) ============ */}
      <div
        className="card"
        style={{
          padding: 24,
          marginBottom: 24,
          background: "var(--bg-elevated)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--brand-axon)",
                letterSpacing: 2,
                fontWeight: 600,
                textTransform: "uppercase",
              }}
            >
              REFLECTION · 反思闭环
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--ink-primary)", marginTop: 4 }}>
              从教训到改进到效果
            </div>
          </div>
          {funnel && (
            <BigNumber
              value={funnel.total}
              size="md"
              format="thousand"
              style={{ color: "var(--brand-axon)" }}
            />
          )}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 24,
            alignItems: "start",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--ink-dim)",
                letterSpacing: 1.5,
                fontWeight: 600,
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              反思闭环漏斗 (5 阶段)
            </div>
            <ReflectionFunnel />
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--ink-dim)",
                letterSpacing: 1.5,
                fontWeight: 600,
                textTransform: "uppercase",
                marginBottom: 12,
              }}
            >
              主题星云 (Constellation)
            </div>
            <Constellation />
          </div>
        </div>
      </div>

      {/* ============ 原有 reflection 功能保留 (KPI 卡 + 列表 + 创建/详情 Modal) ============ */}

      {funnel && (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col span={6}><Card size="small"><Statistic title="反思总数" value={funnel.total} styles={{ content: { color: "#e8e8e8", fontSize: 18 } }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="有改进措施" value={funnel.withImprovements} suffix={`${funnel.total > 0 ? Math.round(funnel.withImprovements / funnel.total * 100) : 0}%`} styles={{ content: { color: "#faad14", fontSize: 18 } }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="已执行" value={funnel.improvementsExecuted} styles={{ content: { color: "#52c41a", fontSize: 18 } }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="有效果反馈" value={funnel.withFeedback} styles={{ content: { color: funnel.withFeedback > 0 ? "#52c41a" : "#ff4d4f", fontSize: 18 } }} /></Card></Col>
        </Row>
      )}

      <Card title="反思闭环漏斗" size="small" style={{ marginBottom: 24 }}>
        {funnelOption ? (
          <ReactECharts echarts={echarts} option={funnelOption} style={{ height: 260 }} />
        ) : (
          <Empty description="暂无漏斗数据" />
        )}
      </Card>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        {
          key: "反思列表",
          label: "反思列表",
          children: <>
            <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
              <Select placeholder="状态筛选" allowClear style={{ width: 140 }} onChange={(v) => setStatusFilter(v)}
                options={[{ label: "OPEN", value: "OPEN" }, { label: "IN_PROGRESS", value: "IN_PROGRESS" }, { label: "RESOLVED", value: "RESOLVED" }, { label: "CLOSED", value: "CLOSED" }]} />
              <Select placeholder="来源筛选" allowClear style={{ width: 140 }} onChange={(v) => setSourceTypeFilter(v)}
                options={Object.entries(reflSourceTypeLabel).map(([k, v]) => ({ label: v, value: k }))} />
            </div>
            {loading ? (
              <div style={{ display: "flex", justifyContent: "center", height: 200, alignItems: "center" }}><Spin size="large" /></div>
            ) : filtered.length === 0 ? (
              <Empty description="暂无反思数据" />
            ) : (
              <Table
                dataSource={filtered}
                columns={columns}
                rowKey="id"
                size="small"
                pagination={{
                  current: page,
                  pageSize: pageSize,
                  total: total,
                  showSizeChanger: true,
                  pageSizeOptions: ["20", "50", "100", "200"],
                  showTotal: (t) => `共 ${t} 条反思`,
                  onChange: (p, ps) => { setPage(p); setPageSize(ps); },
                }}
                expandable={{
                  onExpand: async (expanded, record) => {
                    // P0-6: expand 时调 reflection.get 拿 V3 详情(避免 list SQL 列数超 prisma 5.22 binary parser 上限)
                    if (expanded && !record.__loadedDetail) {
                      try {
                        const r = await fetch(`/api/trpc/reflection.get?input=${encodeURIComponent(JSON.stringify(record.id))}`);
                        if (r.ok) {
                          const j = await r.json();
                          const detail = j?.result?.data;
                          if (detail) {
                            // merge V3 fields into record (用 __loadedDetail 标记避免重复 fetch)
                            const merged = { ...record, ...detail, __loadedDetail: true };
                            setItems((prev) => prev.map((it) => (it.id === record.id ? merged : it)));
                          }
                        }
                      } catch (e) { /* ignore, fallback 用 list 已有字段 */ }
                    }
                  },
                  expandedRowRender: (record) => (
                    <div style={{ padding: "8px 0" }}>
                      {/* P0-6: V3 元数据 — source / 主题 / action / 关联 ID / 根因 / 方案 */}
                      {(record.theme || record.actionType || record.processingVersion || record.sourceType || record.agentSource) && (
                        <div style={{ marginBottom: 12, padding: 10, background: "rgba(102,126,234,0.08)", borderRadius: 6, border: "1px solid rgba(102,126,234,0.2)" }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8", marginBottom: 6 }}>V3 元数据</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "6px 16px", fontSize: 12 }}>
                            {record.theme && <div><span style={{ color: "#a0a0b0" }}>主题: </span><span style={{ color: "#e8e8e8" }}>{record.theme}</span></div>}
                            {record.actionType && <div><span style={{ color: "#a0a0b0" }}>Action: </span><Tag color={record.actionType === "CREATE_TASK" ? "blue" : record.actionType === "ALERT" ? "red" : "default"} style={{ fontSize: 11 }}>{record.actionType}</Tag>{record.actionConfidence != null && <span style={{ color: "#a0a0b0", marginLeft: 4 }}>conf={record.actionConfidence.toFixed(2)}</span>}</div>}
                            {record.processingVersion && <div><span style={{ color: "#a0a0b0" }}>版本: </span><span style={{ color: "#e8e8e8" }}>{record.processingVersion}</span></div>}
                            {record.sourceType && <div><span style={{ color: "#a0a0b0" }}>来源类型: </span><span style={{ color: "#e8e8e8" }}>{record.sourceType}</span></div>}
                            {record.agentSource && <div><span style={{ color: "#a0a0b0" }}>写入者: </span><span style={{ color: "#e8e8e8" }}>{record.agentSource}</span></div>}
                            {record.sourceId && <div style={{ gridColumn: "1 / -1", wordBreak: "break-all" }}><span style={{ color: "#a0a0b0" }}>来源 ID: </span><span style={{ color: "#888", fontSize: 11, fontFamily: "monospace" }}>{record.sourceId}</span></div>}
                          </div>
                        </div>
                      )}
                      {(record.relatedMemoryIds || record.relatedKnowledgeIds || record.relatedSessionIds || record.relatedProblemIds) && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8", marginBottom: 6 }}>关联实体</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "6px 16px", fontSize: 12 }}>
                            {record.relatedMemoryIds && <div><span style={{ color: "#a0a0b0" }}>Memory: </span><span style={{ color: "#888", fontFamily: "monospace", fontSize: 11 }}>{record.relatedMemoryIds}</span></div>}
                            {record.relatedKnowledgeIds && <div><span style={{ color: "#a0a0b0" }}>Knowledge: </span><span style={{ color: "#888", fontFamily: "monospace", fontSize: 11 }}>{record.relatedKnowledgeIds}</span></div>}
                            {record.relatedSessionIds && <div><span style={{ color: "#a0a0b0" }}>Session: </span><span style={{ color: "#888", fontFamily: "monospace", fontSize: 11 }}>{record.relatedSessionIds}</span></div>}
                            {record.relatedProblemIds && <div><span style={{ color: "#a0a0b0" }}>Problem: </span><span style={{ color: "#888", fontFamily: "monospace", fontSize: 11 }}>{record.relatedProblemIds}</span></div>}
                          </div>
                        </div>
                      )}
                      {record.rootCauseAnalysis && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8", marginBottom: 4 }}>根因分析</div>
                          <div style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{record.rootCauseAnalysis}</div>
                        </div>
                      )}
                      {record.proposedPlan && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8", marginBottom: 4 }}>提议方案</div>
                          <div style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{record.proposedPlan}</div>
                        </div>
                      )}
                      {record.improvementActions?.length > 0 ? (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8", marginBottom: 8 }}>改进措施</div>
                          {record.improvementActions.map((action) => (
                            <div key={action.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <Tag color={action.status === "completed" ? "green" : action.status === "running" ? "orange" : "default"} style={{ fontSize: 11 }}>
                                {action.status === "completed" ? "已完成" : action.status === "running" ? "进行中" : "待执行"}
                              </Tag>
                              <span style={{ color: "#e8e8e8", fontSize: 13, flex: 1 }}>{action.content}</span>
                              {action.effect && <span style={{ color: "#52c41a", fontSize: 12 }}>效果: {action.effect}</span>}
                            </div>
                          ))}
                        </div>
                      ) : <span style={{ color: "#a0a0b0", fontSize: 12 }}>暂无改进措施</span>}
                    </div>
                  ),
                }}
                onRow={(record) => ({ onClick: () => { setDetailItem(record); setDetailOpen(true); }, style: { cursor: "pointer" } })}
              />
            )}
          </>,
        },
        {
          key: "每日总结",
          label: <span><CalendarOutlined style={{ marginRight: 6 }} />每日总结</span>,
          children: (
            <Row gutter={[16, 16]}>
              <Col span={8}>
                <Card size="small" title="日历" styles={{ body: { padding: 0 } }}>
                  <style>{`
                    .daily-calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); border-top: 1px solid rgba(255,255,255,0.06); }
                    .daily-calendar-header { display: grid; grid-template-columns: repeat(7, 1fr); background: rgba(102,126,234,0.2); border-bottom: 1px solid rgba(255,255,255,0.06); }
                    .daily-calendar-header-cell { padding: 6px 2px; text-align: center; color: #e8e8e8; font-size: 11px; font-weight: 600; border: none; }
                    .daily-calendar-cell { height: 56px; border-right: 1px solid rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.06); padding: 2px; display: flex; flex-direction: column; justify-content: center; align-items: center; }
                    .daily-calendar-cell:hover { background: rgba(102,126,234,0.08); }
                    .daily-calendar-cell.selected { background: rgba(102,126,234,0.25) !important; border-radius: 4px; }
                    .daily-calendar-cell .day-num { font-size: 11px; font-weight: 600; color: #e8e8e8; }
                    .daily-calendar-cell .day-num.empty { color: #a0a0b0; }
                    .daily-calendar-cell .day-stat { font-size: 9px; }
                    .daily-calendar-cell .day-stat.count { color: #667eea; }
                    .daily-calendar-cell .day-stat.resolved { color: #52c41a; }
                  `}</style>
                  {(() => {
                    const now = dayjs(`${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-01`);
                    const year = calendarYear;
                    const month = calendarMonth;
                    const firstDay = dayjs(`${year}-${String(month + 1).padStart(2, '0')}-01`);
                    const daysInMonth = firstDay.daysInMonth();
                    const startWeekday = firstDay.day();
                    const weeks: Array<Array<{ date: number | null; dateKey: string | null; summary: DailySummary | null }>> = [];
                    let week: Array<{ date: number | null; dateKey: string | null; summary: DailySummary | null }> = [];
                    for (let i = 0; i < startWeekday; i++) week.push({ date: null, dateKey: null, summary: null });
                    for (let d = 1; d <= daysInMonth; d++) {
                      const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                      week.push({ date: d, dateKey, summary: dailySummaries.find((s) => s.date === dateKey) ?? null });
                      if (week.length === 7) { weeks.push(week); week = []; }
                    }
                    if (week.length > 0) { while (week.length < 7) week.push({ date: null, dateKey: null, summary: null }); weeks.push(week); }
                    const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
                    return (
                      <div>
                        <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <Button type="text" size="small" onClick={() => { const p = dayjs(`${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-01`).subtract(1, 'month'); setCalendarYear(p.year()); setCalendarMonth(p.month()); setSelectedDate(null); }} style={{ color: "#a0a0b0", width: 24, height: 24, padding: 0 }}>&lt;</Button>
                          <span style={{ color: "#e8e8e8", fontSize: 13, fontWeight: 600 }}>{now.format("YYYY-MM")}</span>
                          <Button type="text" size="small" onClick={() => { const p = dayjs(`${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-01`).add(1, 'month'); setCalendarYear(p.year()); setCalendarMonth(p.month()); setSelectedDate(null); }} style={{ color: "#a0a0b0", width: 24, height: 24, padding: 0 }}>&gt;</Button>
                        </div>
                        <div className="daily-calendar-header">
                          {weekdays.map((w) => <div key={w} className="daily-calendar-header-cell">{w}</div>)}
                        </div>
                        <div className="daily-calendar-grid">
                          {weeks.flat().map((cell, idx) => {
                            const isSelected = cell.dateKey ? selectedDate === cell.dateKey : false;
                            return (
                              <div
                                key={idx}
                                className={`daily-calendar-cell${isSelected ? " selected" : ""}`}
                                onClick={() => cell.dateKey && setSelectedDate(cell.dateKey)}
                                style={{ cursor: cell.dateKey ? "pointer" : "default" }}
                              >
                                {cell.date ? (
                                  <>
                                    <span className={`day-num${!cell.summary ? " empty" : ""}`}>{cell.date}</span>
                                    {cell.summary && (
                                      <>
                                        <span className="day-stat count">{cell.summary.count}条反思</span>
                                        <span className="day-stat resolved">{cell.summary.resolved}已解决</span>
                                      </>
                                    )}
                                  </>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </Card>
              </Col>
              <Col span={16}>
                <Card size="small" title={selectedDate ? `${selectedDate} 每日总结` : "请选择日期"} styles={{ body: { minHeight: 360, padding: 16 } }}>
                  {!selectedSummary ? (
                    <Empty description="选择左侧日期查看当日总结" style={{ marginTop: 120 }} />
                  ) : selectedSummary.items.length === 0 ? (
                    <Empty description="当日无反思记录" />
                  ) : (
                    <div>
                      <Row gutter={[8, 8]} style={{ marginBottom: 16 }}>
                        <Col span={8}><Card size="small"><Statistic title="反思数" value={selectedSummary.count} styles={{ content: { color: "#e8e8e8", fontSize: 16 } }} /></Card></Col>
                        <Col span={8}><Card size="small"><Statistic title="已解决" value={selectedSummary.resolved} styles={{ content: { color: "#52c41a", fontSize: 16 } }} /></Card></Col>
                        <Col span={8}><Card size="small"><Statistic title="未解决" value={selectedSummary.count - selectedSummary.resolved} styles={{ content: { color: "#ff4d4f", fontSize: 16 } }} /></Card></Col>
                      </Row>
                      {(() => {
                        const reflections = selectedSummary.items;
                        const totalActions = reflections.flatMap((r) => r.improvementActions || []).length;
                        const completedActions = reflections.flatMap((r) => r.improvementActions || []).filter((a) => a.status === "completed").length;
                        const pendingActions = totalActions - completedActions;
                        const avgScore = reflections.filter((r) => r.score).reduce((s, r) => s + (r.score ?? 0), 0) / (reflections.filter((r) => r.score).length || 1);

                        const descriptions = reflections.filter((r) => r.description).map((r) => r.description!);
                        const lessons = reflections.filter((r) => r.lesson).map((r) => ({ text: r.lesson!, title: r.title, priority: r.priority }));
                        const insights = reflections.filter((r) => r.insight).map((r) => ({ text: r.insight!, title: r.title, priority: r.priority }));
                        const improvements = reflections.filter((r) => r.improvements).map((r) => ({ text: r.improvements!, title: r.title, priority: r.priority }));
                        const actions = reflections.flatMap((r) => (r.improvementActions || []).map((a) => ({ content: a.content, status: a.status, reflection: r.title, reflectionId: r.id })));
                        const pendingActionsList = actions.filter((a) => a.status !== "completed");

                        const scoreLabel = avgScore >= 8 ? "收获丰富" : avgScore >= 6 ? "中规中矩" : avgScore >= 4 ? "有待提升" : "困难重重";
                        const actionRate = totalActions > 0 ? Math.round(completedActions / totalActions * 100) : 0;
                        const p1Count = reflections.filter((r) => r.priority === "P1").length;
                        const p2Count = reflections.filter((r) => r.priority === "P2").length;

                        const priorityBadge = (p: string | null) => {
                          if (!p) return null;
                          const color = p === "P1" ? "#ff4d4f" : p === "P2" ? "#faad14" : "#a0a0b0";
                          return <span style={{ color, fontSize: 10, fontWeight: 700, marginLeft: 6 }}>{p}</span>;
                        };

                        const renderItemCards = <T extends { text: string; title: string; priority: string | null }>(
                          items: T[], color: string, emoji: string, label: string
                        ) => {
                          if (items.length === 0) return null;
                          if (items.length === 1) {
                            return (
                              <div style={{ background: `${color}14`, border: `1px solid ${color}38`, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                                <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 6 }}>{emoji} {label}{priorityBadge(items[0].priority)}</div>
                                <div style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 1.8 }}>{items[0].text}</div>
                                <div style={{ fontSize: 11, color: "#a0a0b0", marginTop: 4 }}>来自：{items[0].title}</div>
                              </div>
                            );
                          }
                          return (
                            <div style={{ background: `${color}14`, border: `1px solid ${color}38`, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                              <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 8 }}>{emoji} {label}（{items.length}条）</div>
                              {items.map((item, i) => (
                                <div key={i} style={{ marginBottom: i < items.length - 1 ? 10 : 0 }}>
                                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                                    <span style={{ color, fontWeight: 600, fontSize: 12, flexShrink: 0, marginTop: 2 }}>{i + 1}.</span>
                                    <div style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 1.8 }}>{item.text}{priorityBadge(item.priority)}</div>
                                  </div>
                                  <div style={{ fontSize: 11, color: "#a0a0b0", marginLeft: 20, marginTop: 2 }}>来自：{item.title}</div>
                                </div>
                              ))}
                            </div>
                          );
                        };

                        return (
                          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            {/* 今日概览 */}
                            <div style={{ background: "rgba(102,126,234,0.08)", border: "1px solid rgba(102,126,234,0.25)", borderRadius: 8, padding: "10px 14px" }}>
                              <div style={{ fontWeight: 600, fontSize: 12, color: "#667eea", marginBottom: 8 }}>📋 今日概览</div>
                              <div style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 2 }}>
                                <div>共 <strong style={{ color: "#667eea" }}>{reflections.length}</strong> 条反思
                                  {p1Count > 0 && <span style={{ color: "#ff4d4f", fontWeight: 600 }}> · {p1Count}个P1</span>}
                                  {p2Count > 0 && <span style={{ color: "#faad14", fontWeight: 600 }}> · {p2Count}个P2</span>}
                                </div>
                                <div>
                                  {descriptions.length > 0
                                    ? `涉及 ${Array.from(new Set(descriptions)).slice(0, 3).join("；")}${descriptions.length > 3 ? "等" : ""}`
                                    : reflections[0]?.title ? `主要为"${reflections[0].title}"相关` : "暂无主题"}
                                </div>
                                {avgScore > 0 && <div>综合评分 <strong style={{ color: "#faad14" }}>{avgScore.toFixed(1)}</strong>/10 · 整体{scoreLabel}</div>}
                                {totalActions > 0 && (
                                  <div>
                                    行动计划 <strong style={{ color: pendingActions > 0 ? "#eb2f96" : "#52c41a" }}>{completedActions}</strong>/{totalActions} 项
                                    {actionRate > 0 && <span style={{ color: "#a0a0b0" }}> · 完成率{actionRate}%</span>}
                                    {pendingActions > 0 && <span style={{ color: "#eb2f96" }}> · 遗留{pendingActions}项</span>}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* P1-8: V3 主题 / Action 分布 */}
                            {(() => {
                              const themes: Record<string, number> = {};
                              const actionTypes: Record<string, number> = {};
                              let confSum = 0, confCnt = 0;
                              reflections.forEach((r) => {
                                const t = r.theme || "未分类";
                                themes[t] = (themes[t] || 0) + 1;
                                const at = r.actionType || "NONE";
                                actionTypes[at] = (actionTypes[at] || 0) + 1;
                                if (r.actionConfidence != null) { confSum += r.actionConfidence; confCnt++; }
                              });
                              const themeEntries = Object.entries(themes).sort((a, b) => b[1] - a[1]).slice(0, 5);
                              const actionEntries = Object.entries(actionTypes).sort((a, b) => b[1] - a[1]);
                              const avgConf = confCnt > 0 ? confSum / confCnt : 0;
                              if (themeEntries.length === 0 && actionEntries.length === 0) return null;
                              return (
                                <div style={{ background: "rgba(118,75,162,0.08)", border: "1px solid rgba(118,75,162,0.25)", borderRadius: 8, padding: "10px 14px" }}>
                                  <div style={{ fontWeight: 600, fontSize: 12, color: "#a974ff", marginBottom: 8 }}>🔮 V3 主题 / Action 分布</div>
                                  {confCnt > 0 && (
                                    <div style={{ color: "#e8e8e8", fontSize: 12, marginBottom: 6 }}>
                                      平均 Action 置信度 <strong style={{ color: "#a974ff" }}>{(avgConf * 100).toFixed(0)}%</strong>
                                    </div>
                                  )}
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ color: "#a0a0b0", fontSize: 11, marginBottom: 4 }}>主题</div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                      {themeEntries.map(([t, c]) => (
                                        <Tag key={t} color={t === "未分类" ? "default" : "purple"} style={{ fontSize: 11 }}>
                                          {t} × {c}
                                        </Tag>
                                      ))}
                                    </div>
                                  </div>
                                  <div>
                                    <div style={{ color: "#a0a0b0", fontSize: 11, marginBottom: 4 }}>Action</div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                      {actionEntries.map(([a, c]) => (
                                        <Tag key={a} color={a === "CREATE_TASK" ? "blue" : a === "ALERT" ? "red" : a === "NONE" ? "default" : "purple"} style={{ fontSize: 11 }}>
                                          {a} × {c}
                                        </Tag>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* 核心教训 */}
                            {renderItemCards(lessons, "#faad14", "📌", "核心教训")}

                            {/* 关键洞察 */}
                            {renderItemCards(insights, "#52c41a", "💡", "关键洞察")}

                            {/* 改进方向 */}
                            {renderItemCards(improvements, "#eb2f96", "🎯", "改进方向")}

                            {/* 改进措施 */}
                            {actions.length > 0 && (
                              <div style={{ background: "rgba(102,126,234,0.08)", border: "1px solid rgba(102,126,234,0.25)", borderRadius: 8, padding: "10px 14px" }}>
                                <div style={{ fontWeight: 600, fontSize: 12, color: "#667eea", marginBottom: 8 }}>⚙️ 改进措施（{actions.length}条）</div>
                                {actions.map((a, i) => (
                                  <div key={i} style={{ marginBottom: 6 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                      <span style={{ color: a.status === "completed" ? "#52c41a" : "#a0a0b0", fontSize: 12, width: 14, textAlign: "center" }}>{a.status === "completed" ? "✓" : "○"}</span>
                                      <span style={{ color: "#e8e8e8", fontSize: 13, textDecoration: a.status === "completed" ? "line-through" : "none", opacity: a.status === "completed" ? 0.6 : 1 }}>{a.content}</span>
                                    </div>
                                    <div style={{ fontSize: 11, color: "#a0a0b0", marginLeft: 22 }}>来自：{a.reflection}</div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* 遗留行动 */}
                            {pendingActionsList.length > 0 && (
                              <div style={{ background: "rgba(235,47,150,0.08)", border: "1px solid rgba(235,47,150,0.25)", borderRadius: 8, padding: "10px 14px" }}>
                                <div style={{ fontWeight: 600, fontSize: 12, color: "#eb2f96", marginBottom: 8 }}>🔴 遗留行动（{pendingActionsList.length}条，待明日继续）</div>
                                {pendingActionsList.map((a, i) => (
                                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                    <span style={{ color: "#eb2f96", fontSize: 11, fontWeight: 600 }}>○</span>
                                    <span style={{ color: "#e8e8e8", fontSize: 13 }}>{a.content}</span>
                                    <span style={{ fontSize: 11, color: "#a0a0b0" }}>（{a.reflection}）</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </Card>
              </Col>
            </Row>
          ),
        },
      ]} />

      <Modal title="新建反思" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="创建" cancelText="取消">
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input placeholder="反思标题" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="反思描述..." />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="priority" label="优先级">
                <Select allowClear placeholder="选择" options={[{ label: "P1", value: "P1" }, { label: "P2", value: "P2" }, { label: "P3", value: "P3" }]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="score" label="评分">
                <InputNumber min={1} max={10} style={{ width: "100%" }} placeholder="1-10" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="lesson" label="教训">
            <Input.TextArea rows={2} placeholder="从中学到的教训..." />
          </Form.Item>
          <Form.Item name="insight" label="洞察">
            <Input.TextArea rows={2} placeholder="反思后的洞察..." />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`解决反思: ${resolveItem?.title ?? ""}`} open={resolveOpen} onCancel={() => { setResolveOpen(false); setResolveItem(null); setResolveInsight(""); }} onOk={handleResolve} okText="确认解决" cancelText="取消" okButtonProps={{ style: { background: "#52c41a" } }}>
        <div style={{ marginBottom: 16, color: "#a0a0b0", fontSize: 13 }}>
          解决后将自动沉淀为记忆，并记录飞轮事件。
        </div>
        <Form.Item label="洞察/收获（可选）">
          <Input.TextArea rows={4} value={resolveInsight} onChange={(e) => setResolveInsight(e.target.value)} placeholder="解决这个反思后的洞察..." />
        </Form.Item>
      </Modal>

      <Modal
        title="反思详情"
        open={detailOpen}
        onCancel={() => { setDetailOpen(false); setDetailItem(null); }}
        footer={null}
        width={620}
      >
        {detailItem ? (
          <div>
            <div style={{ marginBottom: 16, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Tag color={statusColor(detailItem.status)} style={{ fontSize: 13, padding: "2px 8px" }}>{detailItem.status}</Tag>
              {detailItem.priority && <Tag color={detailItem.priority === "P1" ? "red" : "orange"}>{detailItem.priority}</Tag>}
              {detailItem.score && <span style={{ color: "#e8e8e8", fontSize: 13, marginLeft: 8 }}>评分: {detailItem.score}/10</span>}
              {detailItem.sourceType && <Tag color={reflSourceTypeColor[detailItem.sourceType] ?? "default"}>{reflSourceTypeLabel[detailItem.sourceType] ?? detailItem.sourceType}</Tag>}
              {detailItem.theme && <Tag color="purple" style={{ fontSize: 11 }}>{detailItem.theme}</Tag>}
              {detailItem.supersededBy && <Tag color="red">已废弃</Tag>}
              {detailItem.reinforceCount != null && detailItem.reinforceCount > 0 && <Tag color="gold">强化 x{detailItem.reinforceCount}</Tag>}
            </div>
            <h3 style={{ color: "#e8e8e8", marginBottom: 12 }}>{detailItem.title}</h3>

            {detailItem.description && (
              <div style={{ background: "rgba(255,255,255,0.03)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "#667eea", marginBottom: 4, fontSize: 12 }}>描述</div>
                <p style={{ color: "#e8e8e8", fontSize: 14, lineHeight: 1.6 }}>{detailItem.description}</p>
              </div>
            )}

            {detailItem.lesson && (
              <div style={{ background: "rgba(255,255,255,0.03)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "#faad14", marginBottom: 4, fontSize: 12 }}>教训</div>
                <p style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 1.6 }}>{detailItem.lesson}</p>
              </div>
            )}

            {detailItem.insight && (
              <div style={{ background: "rgba(255,255,255,0.03)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "#52c41a", marginBottom: 4, fontSize: 12 }}>洞察</div>
                <p style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 1.6 }}>{detailItem.insight}</p>
              </div>
            )}

            {detailItem.improvements && (
              <div style={{ background: "rgba(255,255,255,0.03)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "#eb2f96", marginBottom: 4, fontSize: 12 }}>改进方向</div>
                <p style={{ color: "#e8e8e8", fontSize: 13, lineHeight: 1.6 }}>{detailItem.improvements}</p>
              </div>
            )}

            {detailItem.improvementActions?.length > 0 && (
              <div style={{ background: "rgba(255,255,255,0.03)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "#667eea", marginBottom: 8, fontSize: 12 }}>改进措施</div>
                {detailItem.improvementActions.map((a) => (
                  <div key={a.id} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 13, alignItems: "center" }}>
                    <Tag color={a.status === "completed" ? "green" : "default"} style={{ fontSize: 11 }}>{a.status}</Tag>
                    <span style={{ color: "#e8e8e8", flex: 1 }}>{a.content}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 12, color: "#a0a0b0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <div>创建：{new Date(detailItem.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
              <div>更新：{new Date(detailItem.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
