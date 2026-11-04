"use client";

import { useState, useEffect } from "react";
import { useThemeColors } from "@/hooks/useThemeColors";
import { Table, Tag, Input, Empty, Spin, Button, Modal, Form, Select, Row, Col, Card, message } from "antd";
import { BookOutlined, PlusOutlined } from "@ant-design/icons";
import dynamic from "next/dynamic";
const ReactECharts = dynamic(() => import("echarts-for-react/lib/core"), { ssr: false });
import * as echarts from "echarts/core";
import { GraphChart } from "echarts/charts";
import { TooltipComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { KPICard } from "@lions/ui";

echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer]);

interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  category: string | null;
  tags: string | null;
  confidence: number;
  usageCount: number;
  sourceType: string | null;
  sourceDetail: string | null;
  sourceId: string | null;
  filePath: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // V3 字段
  theme: string | null;
  supersededBy: string | null;
  reinforceCount: number | null;
}

const sourceTypeLabel: Record<string, string> = {
  LEARNING: "学习获得",
  PRACTICE: "实践获得",
  QUERY: "查询获得",
  SELF_SUMMARY: "自我总结",
  USER_PROVIDED: "用户告知",
  MANUAL: "手动创建",
  GLOBAL_ORGANIZER: "全局整理",
  PIPELINE_HERMES: "Hermes碎片",
  "PIPELINE_agent-h": "UT碎片",
  PIPELINE_CLAUDE: "Claude碎片",
};

const sourceTypeColor: Record<string, string> = {
  LEARNING: "blue",
  PRACTICE: "green",
  QUERY: "purple",
  SELF_SUMMARY: "orange",
  USER_PROVIDED: "red",
  MANUAL: "default",
  GLOBAL_ORGANIZER: "blue",
  PIPELINE_HERMES: "default",
  "PIPELINE_agent-h": "default",
  PIPELINE_CLAUDE: "default",
};

interface GraphNode {
  id: string;
  name: string;
  category: string | null;
  tags: string[];
  symbolSize: number;
  value: number;
}

interface GraphLink {
  source: string;
  target: string;
  value: number;
}

export default function KnowledgePage() {
  const C = useThemeColors();
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string | undefined>();
  const [tagFilter, setTagFilter] = useState<string | undefined>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<KnowledgeItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!detailOpen) setDetailItem(null);
  }, [detailOpen]);

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      // Load ALL knowledge by looping pages
      (async () => {
        const allItems: KnowledgeItem[] = [];
        let page = 1;
        const pageSize = 200;
        while (true) {
          const res = await fetch("/api/trpc/knowledge.list?input=" + encodeURIComponent(JSON.stringify({ page, pageSize, sortBy: "updatedAt", sortOrder: "desc" })));
          const json = await res.json();
          if (json.error) { console.error(json.error.message); break; }
          const items = json.result?.data?.items ?? [];
          allItems.push(...items);
          if (items.length < pageSize) break;
          page++;
        }
        return allItems;
      })(),
      fetch("/api/trpc/knowledge.getGraph").then((r) => r.json()),
    ])
      .then(([allItems, graphJson]) => {
        setItems(allItems);
        setGraphData(graphJson.result?.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async (values: { title: string; content: string; category?: string; tags?: string; sourceType?: string }) => {
    try {
      const res = await fetch("/api/trpc/knowledge.create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.result) {
        message.success("知识已创建");
        setCreateOpen(false);
        form.resetFields();
        fetchData();
      }
    } catch {
      message.error("创建失败");
    }
  };

  const categories = Array.from(new Set(items.map((k) => k.category).filter(Boolean) as string[]));
  const tagsWithData = items.map((k) => k.tags).filter(Boolean) as string[];
  const allTags = Array.from(new Set(tagsWithData.flatMap((t) => t.split(",")).map((t) => t.trim())));
  const filtered = items.filter((item) => {
    if (categoryFilter && item.category !== categoryFilter) return false;
    if (sourceTypeFilter && item.sourceType !== sourceTypeFilter) return false;
    if (tagFilter && (!item.tags || !item.tags.includes(tagFilter))) return false;
    if (search && !item.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const avgConfidence = items.length > 0 ? (items.reduce((s, k) => s + k.confidence, 0) / items.length) : 0;
  const totalUsage = items.reduce((s, k) => s + k.usageCount, 0);

  const graphOption = graphData && graphData.nodes.length > 0 ? {
    tooltip: { backgroundColor: C.surfaceHi, borderColor: C.borderHi, textStyle: { color: C.inkPrimary }, formatter: (params: { data: GraphNode }) => `<b>${params.data.name}</b><br/>分类: ${params.data.category ?? "-"}<br/>置信度: ${(params.data.value ?? 0).toFixed(2)}<br/>标签: ${(params.data.tags ?? []).join(", ") || "-"}` },
    series: [{
      type: "graph",
      layout: "force",
      data: graphData.nodes.map((n) => ({
        ...n,
        label: { show: true, color: C.inkPrimary, fontSize: 11 },
        itemStyle: {
          // 6 分类 → 6 token 色 (用真实色)
          color: n.category === "Frontend" ? C.brandFlow
              : n.category === "Backend" ? C.statusOk
              : n.category === "Domain" ? C.statusWarn
              : n.category === "System Design" ? C.brandFlow
              : n.category === "Tooling" ? C.brandSynapse
              : C.brandAxon,
          borderColor: C.borderHi,
          borderWidth: 1,
        },
      })),
      links: graphData.links.map((l) => ({
        ...l,
        lineStyle: { color: C.borderHi, curveness: 0.2, width: Math.min(4, l.value) },
      })),
      force: { repulsion: 200, edgeLength: [80, 160], gravity: 0.1 },
      roam: true,
      draggable: true,
      emphasis: { focus: "adjacency", lineStyle: { width: 3 } },
    }],
  } : null;

  const fmtTime = (v: string) => v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
  const columns = [
    { title: "标题", dataIndex: "title", key: "title", sorter: (a: KnowledgeItem, b: KnowledgeItem) => a.title.localeCompare(b.title), render: (v: string) => <span style={{ color: "var(--ink-primary)", fontWeight: 500, cursor: "pointer" }}>{v}</span> },
    { title: "主题", dataIndex: "theme", key: "theme", width: 100, ellipsis: true, render: (v: string | null) => v ? <Tag style={{ fontSize: 11 }}>{v}</Tag> : "-" },
    { title: "分类", dataIndex: "category", key: "category", width: 90, sorter: (a: KnowledgeItem, b: KnowledgeItem) => (a.category ?? "").localeCompare(b.category ?? ""), render: (v: string | null) => v ? <Tag color="geekblue">{v}</Tag> : "-" },
    { title: "来源", dataIndex: "sourceType", key: "sourceType", width: 90, sorter: (a: KnowledgeItem, b: KnowledgeItem) => (a.sourceType ?? "").localeCompare(b.sourceType ?? ""), render: (v: string | null) => v ? <Tag color={sourceTypeColor[v] ?? "default"}>{sourceTypeLabel[v] ?? v}</Tag> : "-" },
    { title: "置信度", dataIndex: "confidence", key: "confidence", width: 70, sorter: (a: KnowledgeItem, b: KnowledgeItem) => a.confidence - b.confidence, render: (v: number) => <span style={{ color: v > 0.7 ? "var(--status-ok)" : "var(--status-warn)" }}>{v.toFixed(2)}</span> },
    { title: "创建时间", dataIndex: "createdAt", key: "createdAt", width: 120, sorter: (a: KnowledgeItem, b: KnowledgeItem) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(), render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", width: 120, sorter: (a: KnowledgeItem, b: KnowledgeItem) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(), defaultSortOrder: "descend" as const, render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: "var(--ink-primary)" }}><BookOutlined style={{ marginRight: 8 }} />知识库</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建知识</Button>
      </div>

      {/* 4 KPI — KPICard 改造 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={6}><KPICard label="知识总数" value={items.length} suffix="篇" tone="mind" size="sm" /></Col>
        <Col span={6}><KPICard label="分类数" value={categories.length} tone="flow" size="sm" /></Col>
        <Col span={6}><KPICard label="平均置信度" value={avgConfidence} tone="ok" size="sm" format="raw" precision={2} /></Col>
        <Col span={6}><KPICard label="总使用次数" value={totalUsage} tone="warn" size="sm" /></Col>
      </Row>

      <Card title="知识图谱" size="small" style={{ marginBottom: 24 }}>
        {graphOption ? (
          <ReactECharts echarts={echarts} option={graphOption} style={{ height: 350 }} />
        ) : (
          <Empty description="暂无知识图谱数据" />
        )}
      </Card>

      <div style={{ marginBottom: 16, display: "flex", gap: 12 }}>
        <Select placeholder="分类" allowClear style={{ width: 140 }} onChange={(v) => setCategoryFilter(v)}
          options={categories.map((c) => ({ label: c, value: c }))} />
        <Select placeholder="来源" allowClear style={{ width: 130 }} onChange={(v) => setSourceTypeFilter(v)}
          options={Object.entries(sourceTypeLabel).map(([k, v]) => ({ label: v, value: k }))} />
        <Select placeholder="标签" allowClear style={{ width: 130 }} onChange={(v) => setTagFilter(v)}
          options={allTags.slice(0, 30).map((t) => ({ label: t, value: t }))} />
        <Input.Search placeholder="搜索知识..." style={{ width: 200 }} onSearch={(v) => setSearch(v)} allowClear />
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", height: 200, alignItems: "center" }}><Spin size="large" /></div>
      ) : filtered.length === 0 ? (
        <Empty description="暂无知识数据" />
      ) : (
        <Table
          dataSource={filtered}
          columns={columns}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 20 }}
          onRow={(record) => ({ onClick: () => { setDetailItem(record); setDetailOpen(true); }, style: { cursor: "pointer" } })}
        />
      )}

      <Modal title="新建知识" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="创建" cancelText="取消">
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input placeholder="知识标题" />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <Input.TextArea rows={5} placeholder="知识内容..." />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="category" label="分类">
                <Select allowClear placeholder="选择" options={[
                  { label: "Frontend", value: "Frontend" }, { label: "Backend", value: "Backend" },
                  { label: "Domain", value: "Domain" }, { label: "System Design", value: "System Design" },
                  { label: "Tooling", value: "Tooling" },
                ]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="sourceType" label="来源类型">
                <Select allowClear placeholder="选择" options={[
                  { label: "学习获得 (LEARNING)", value: "LEARNING" },
                  { label: "实践获得 (PRACTICE)", value: "PRACTICE" },
                  { label: "查询获得 (QUERY)", value: "QUERY" },
                  { label: "自我总结 (SELF_SUMMARY)", value: "SELF_SUMMARY" },
                  { label: "用户告知 (USER_PROVIDED)", value: "USER_PROVIDED" },
                  { label: "手动创建 (MANUAL)", value: "MANUAL" },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="tags" label="标签（逗号分隔）">
            <Input placeholder="例如：react,hooks,typescript" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="知识详情"
        open={detailOpen}
        onCancel={() => { setDetailOpen(false); setDetailItem(null); }}
        footer={null}
        width={620}
      >
        {detailItem ? (
          <div>
            <h3 style={{ color: "var(--ink-primary)", marginBottom: 12 }}>{detailItem.title}</h3>
            <div style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {detailItem.theme && <Tag color="purple">{detailItem.theme}</Tag>}
              {detailItem.category && <Tag color="geekblue">{detailItem.category}</Tag>}
              {detailItem.sourceType && <Tag color={sourceTypeColor[detailItem.sourceType] ?? "default"}>
                {sourceTypeLabel[detailItem.sourceType] ?? detailItem.sourceType}
              </Tag>}
              {detailItem.supersededBy && <Tag color="red">已废弃</Tag>}
              {detailItem.reinforceCount != null && detailItem.reinforceCount > 0 && <Tag color="gold">强化 ×{detailItem.reinforceCount}</Tag>}
              <Tag color={detailItem.confidence > 0.7 ? "green" : "orange"}>置信度 {detailItem.confidence.toFixed(2)}</Tag>
            </div>

            {/* 来源信息 */}
            <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>来源信息</div>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 6, fontSize: 13 }}>
                <span style={{ color: "var(--ink-tertiary)" }}>来源类型：</span>
                <span style={{ color: "var(--ink-primary)" }}>{sourceTypeLabel[detailItem.sourceType ?? ""] ?? detailItem.sourceType ?? "-"}</span>
                <span style={{ color: "var(--ink-tertiary)" }}>来源详情：</span>
                <span style={{ color: "var(--ink-primary)" }}>{detailItem.sourceDetail ?? "-"}</span>
                {detailItem.sourceId && (
                  <>
                    <span style={{ color: "var(--ink-tertiary)" }}>来源ID：</span>
                    <span style={{ color: "var(--ink-primary)", fontSize: 11, wordBreak: "break-all" }}>{detailItem.sourceId}</span>
                  </>
                )}
                {detailItem.filePath && (
                  <>
                    <span style={{ color: "var(--ink-tertiary)" }}>文件路径：</span>
                    <span style={{ color: "var(--ink-primary)", fontSize: 11, wordBreak: "break-all" }}>{detailItem.filePath}</span>
                  </>
                )}
              </div>
            </div>

            {/* 内容 */}
            <div style={{ background: "var(--surface)", padding: 16, borderRadius: 8, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>内容</div>
              <p style={{ color: "var(--ink-primary)", lineHeight: 1.8, fontSize: 14, whiteSpace: "pre-wrap" }}>{detailItem.content}</p>
            </div>

            {/* 标签 */}
            {detailItem.tags && (
              <div style={{ marginBottom: 12 }}>
                <span style={{ color: "var(--ink-tertiary)", fontSize: 12, marginRight: 8 }}>标签：</span>
                {detailItem.tags.split(",").map((t) => <Tag key={t} style={{ fontSize: 11, marginTop: 4 }}>{t.trim()}</Tag>)}
              </div>
            )}

            {/* 统计信息 */}
            <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>统计数据</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
                <div><span style={{ color: "var(--ink-tertiary)" }}>使用次数：</span><span style={{ color: "var(--ink-primary)" }}>{detailItem.usageCount} 次</span></div>
                <div><span style={{ color: "var(--ink-tertiary)" }}>置信度：</span><span style={{ color: detailItem.confidence > 0.7 ? "var(--status-ok)" : "var(--status-warn)" }}>{detailItem.confidence.toFixed(2)}</span></div>
                {detailItem.lastUsedAt && (
                  <div><span style={{ color: "var(--ink-tertiary)" }}>上次使用：</span><span style={{ color: "var(--ink-primary)" }}>{new Date(detailItem.lastUsedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span></div>
                )}
              </div>
            </div>

            {/* 时间信息 */}
            <div style={{ fontSize: 12, color: "var(--ink-tertiary)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <div>创建：{new Date(detailItem.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
              <div>更新：{new Date(detailItem.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
