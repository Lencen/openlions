"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Table, Tag, Select, Input, Row, Col, Empty, Spin, Button, Modal, Form, message, Collapse, Segmented, Tooltip, Progress } from "antd";
import { BulbOutlined, PlusOutlined, FolderOutlined, UnorderedListOutlined } from "@ant-design/icons";
import dynamic from "next/dynamic";
const ReactECharts = dynamic(() => import("echarts-for-react/lib/core"), { ssr: false });
import * as echarts from "echarts/core";
import { PieChart, BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { KPICard } from "@lions/ui";
import { useThemeColors } from "@/hooks/useThemeColors";

echarts.use([PieChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

interface MemoryItem {
  id: string; content: string; summary?: string | null;
  title: string | null; tier: string; type: string | null;
  domain: string | null; valueScore: number; accessCount: number;
  tags: string | null; sourceType: string | null; sourceId: string | null;
  theme: string | null; agentSource: string | null;
  reinforceCount: number | null; supersededBy: string | null;
  importance: number | null; qualityScore: number | null;
  createdAt: string; updatedAt: string;
}

interface TopicItem {
  id: string; name: string; memoryCount: number;
  activeCount: number; supersededCount: number;
  avgImportance: number | null; bestMemoryId: string | null;
  latestUpdate: string | null;
}

const tierColorMap: Record<string, string> = { HOT: "var(--status-err)", WARM: "var(--status-warn)", COLD: "var(--brand-mind)" };
const srcLabel: Record<string, string> = {
  GLOBAL_ORGANIZER: "全局整理", PIPELINE_HERMES: "Hermes碎片",
  "PIPELINE_agent-h": "UT碎片", PIPELINE_CLAUDE: "Claude碎片",
  FLYWHEEL_STRUCTURED: "结构化整理", FLYWHEEL_REFLECTION: "反思产物", mcp: "MCP",
};
const srcColor: Record<string, string> = {
  GLOBAL_ORGANIZER: "blue", FLYWHEEL_STRUCTURED: "geekblue",
  FLYWHEEL_REFLECTION: "purple", mcp: "purple",
};

function tryParseContent(content: string): { summary: string; structured: Record<string, any> | null } {
  try {
    const p = JSON.parse(content);
    if (p && typeof p === "object" && (p.summary || p.claim || p.statement)) {
      return { summary: p.summary || p.claim || p.statement || "", structured: p };
    }
  } catch { /* legacy */ }
  return { summary: content, structured: null };
}

function qualityColor(q: number): string {
  if (q >= 0.7) return "#52c41a";
  if (q >= 0.4) return "#faad14";
  return "#ff4d4f";
}

export default function MemoryPage() {
  const C = useThemeColors();
  const [view, setView] = useState<"topic" | "list">("topic");
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [topics, setTopics] = useState<TopicItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [tierDist, setTierDist] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);
  const [tierFilter, setTierFilter] = useState<string | undefined>();
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [detailItem, setDetailItem] = useState<MemoryItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchTopics = useCallback(async () => {
    const res = await fetch("/api/trpc/memory.themeSummary?input=" + encodeURIComponent(JSON.stringify({ activeOnly })));
    const json = await res.json();
    return (json.result?.data ?? []) as TopicItem[];
  }, [activeOnly]);

  const fetchList = useCallback(async (p: number) => {
    const input = { page: p, pageSize, sortBy: "updatedAt", sortOrder: "desc", activeOnly, tier: tierFilter, sourceType: sourceTypeFilter, search };
    const res = await fetch("/api/trpc/memory.list?input=" + encodeURIComponent(JSON.stringify(input)));
    const json = await res.json();
    return { items: (json.result?.data?.items ?? []) as MemoryItem[], total: (json.result?.data?.total ?? 0) as number };
  }, [pageSize, activeOnly, tierFilter, sourceTypeFilter, search]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [topicData, distRes] = await Promise.all([
        fetchTopics(),
        fetch("/api/trpc/memory.getTierDistribution").then(r => r.json()),
      ]);
      setTopics(topicData);
      setTierDist(distRes.result?.data ?? null);
      const { items, total: t } = await fetchList(1);
      setMemories(items);
      setTotal(t);
      setPage(1);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [fetchTopics, fetchList]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onSearch = (v: string) => { setSearch(v); };
  const onTierChange = (v: any) => { setTierFilter(v); };
  const onSrcChange = (v: any) => { setSourceTypeFilter(v); };

  const onTableChange = async (p: number, ps: number) => {
    setLoading(true);
    const { items } = await fetchList(p);
    setMemories(items);
    setPage(p);
    setLoading(false);
  };

  const fetchTopicDetail = async (topicName: string) => {
    setLoading(true);
    const input = { page: 1, pageSize: 50, sortBy: "importance", sortOrder: "desc", activeOnly, theme: topicName };
    const res = await fetch("/api/trpc/memory.list?input=" + encodeURIComponent(JSON.stringify(input)));
    const json = await res.json();
    setMemories((json.result?.data?.items ?? []) as MemoryItem[]);
    setTotal(json.result?.data?.total ?? 0);
    setPage(1);
    setLoading(false);
  };

  const fmtTime = (v: string) => v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";

  const columns = [
    { title: "层级", dataIndex: "tier", key: "tier", width: 60,
      render: (v: string) => <Tag color={tierColorMap[v] ?? "default"}>{v}</Tag> },
    { title: "内容", key: "content", ellipsis: true,
      render: (_: any, r: MemoryItem) => {
        const { summary, structured } = tryParseContent(r.content);
        return <span style={{ cursor: "pointer" }}>
          {structured ? <Tag color="geekblue" style={{ fontSize: 10 }}>结构化</Tag> : null}
          {summary.length > 80 ? summary.slice(0, 80) + "..." : summary}
        </span>;
      } },
    { title: "质量", dataIndex: "qualityScore", key: "q", width: 70,
      sorter: (a: MemoryItem, b: MemoryItem) => (a.qualityScore ?? 0) - (b.qualityScore ?? 0),
      render: (v: number | null) => v != null && v > 0
        ? <Tooltip title={`质量分: ${v.toFixed(2)}`}><Progress type="circle" percent={Math.round(v * 100)} size={28} strokeColor={qualityColor(v)} /></Tooltip>
        : <span style={{ color: "var(--ink-tertiary)", fontSize: 11 }}>-</span> },
    { title: "来源", dataIndex: "sourceType", key: "src", width: 90,
      render: (v: string | null) => v ? <Tag color={srcColor[v] ?? "default"}>{srcLabel[v] ?? v}</Tag> : "-" },
    { title: "主题", dataIndex: "theme", key: "theme", width: 90, ellipsis: true,
      render: (v: string | null) => v ? <Tag style={{ fontSize: 11 }}>{v}</Tag> : "-" },
    { title: "更新", dataIndex: "updatedAt", key: "upd", width: 110,
      render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0, color: "var(--ink-primary)" }}><BulbOutlined style={{ marginRight: 8 }} />记忆</h1>
        <Segmented value={view} onChange={(v) => setView(v as any)} options={[
          { label: "主题视图", value: "topic", icon: <FolderOutlined /> },
          { label: "列表视图", value: "list", icon: <UnorderedListOutlined /> },
        ]} />
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col span={6}><KPICard label="总量" value={tierDist?.total ?? 0} tone="mind" size="sm" /></Col>
        <Col span={6}><KPICard label="HOT" value={tierDist?.hot ?? 0} tone="err" size="sm" /></Col>
        <Col span={6}><KPICard label="WARM" value={tierDist?.warm ?? 0} tone="warn" size="sm" /></Col>
        <Col span={6}><KPICard label="COLD" value={tierDist?.cold ?? 0} tone="axon" size="sm" /></Col>
      </Row>

      {view === "list" && (
        <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Select placeholder="层级" allowClear style={{ width: 100 }} onChange={onTierChange}
            options={[{ label: "HOT", value: "HOT" }, { label: "WARM", value: "WARM" }, { label: "COLD", value: "COLD" }]} />
          <Select placeholder="来源" allowClear style={{ width: 130 }} onChange={onSrcChange}
            options={Object.entries(srcLabel).map(([k, v]) => ({ label: v, value: k }))} />
          <Input.Search placeholder="搜索..." style={{ width: 200 }} onSearch={onSearch} allowClear />
          <Segmented value={activeOnly ? "active" : "all"} onChange={(v) => setActiveOnly(v === "active")}
            options={[{ label: "活跃", value: "active" }, { label: "全部", value: "all" }]} />
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", height: 200, alignItems: "center" }}><Spin size="large" /></div>
      ) : view === "topic" ? (
        <Collapse
          items={topics.slice(0, 50).map((t) => ({
            key: t.id,
            label: (
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                <span style={{ fontWeight: 600 }}>{t.name}</span>
                <Tag color="blue">{t.activeCount} 活跃</Tag>
                {t.supersededCount > 0 && <Tag color="default">{t.supersededCount} 废弃</Tag>}
                {t.avgImportance != null && t.avgImportance > 0 && (
                  <Progress type="circle" percent={Math.round(t.avgImportance * 100)} size={20} strokeColor={qualityColor(t.avgImportance)} />
                )}
              </div>
            ),
            children: (
              <div>
                <Button type="link" size="small" onClick={() => { setView("list"); fetchTopicDetail(t.name); }}>
                  查看该主题全部记忆 ({t.memoryCount} 条)
                </Button>
                {t.bestMemoryId && <p style={{ color: "var(--ink-tertiary)", fontSize: 12, marginTop: 4 }}>权威记忆: {t.bestMemoryId.slice(0, 20)}...</p>}
              </div>
            ),
          }))}
        />
      ) : (
        <Table
          dataSource={memories}
          columns={columns}
          rowKey="id"
          size="small"
          pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: onTableChange }}
          onRow={(r) => ({ onClick: () => { setDetailItem(r); setDetailOpen(true); }, style: { cursor: "pointer" } })}
        />
      )}

      <Modal title="记忆详情" open={detailOpen} onCancel={() => { setDetailOpen(false); setDetailItem(null); }} footer={null} width={600}>
        {detailItem && (() => {
          const { summary, structured } = tryParseContent(detailItem.content);
          return (
            <div>
              <div style={{ marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 4 }}>
                <Tag color={tierColorMap[detailItem.tier] ?? "default"}>{detailItem.tier}</Tag>
                {detailItem.sourceType && <Tag color={srcColor[detailItem.sourceType] ?? "default"}>{srcLabel[detailItem.sourceType] ?? detailItem.sourceType}</Tag>}
                {detailItem.theme && <Tag color="purple">{detailItem.theme}</Tag>}
                {detailItem.supersededBy && <Tag color="red">已废弃</Tag>}
                {structured && <Tag color="geekblue">结构化</Tag>}
              </div>

              {structured ? (
                <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>结构化内容</div>
                  {structured.claim && <div style={{ marginBottom: 8 }}><b>论断:</b> {structured.claim}</div>}
                  {structured.reasoning && <div style={{ marginBottom: 8 }}><b>推理:</b> {structured.reasoning}</div>}
                  {structured.scope && <div style={{ marginBottom: 8 }}><b>范围:</b> {structured.scope}</div>}
                  {structured.evidence && Array.isArray(structured.evidence) && structured.evidence.length > 0 && (
                    <div style={{ marginBottom: 8 }}><b>证据:</b><ul style={{ margin: "4px 0", paddingLeft: 20 }}>
                      {structured.evidence.map((e: any, i: number) => <li key={i} style={{ fontSize: 12 }}>{e.excerpt || JSON.stringify(e)}</li>)}
                    </ul></div>
                  )}
                  {detailItem.qualityScore != null && detailItem.qualityScore > 0 && (
                    <div style={{ marginBottom: 8 }}><b>质量分:</b> <Progress percent={Math.round(detailItem.qualityScore * 100)} size="small" strokeColor={qualityColor(detailItem.qualityScore)} style={{ width: 120, display: "inline-flex" }} /></div>
                  )}
                </div>
              ) : (
                <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>内容</div>
                  <p style={{ color: "var(--ink-primary)", lineHeight: 1.8, whiteSpace: "pre-wrap" }}>{summary}</p>
                </div>
              )}

              <div style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>
                创建: {fmtTime(detailItem.createdAt)} | 更新: {fmtTime(detailItem.updatedAt)}
                {detailItem.importance != null && ` | 重要度: ${detailItem.importance.toFixed(2)}`}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
