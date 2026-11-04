"use client";

import { useState, useEffect } from "react";
import { Table, Tag, Select, Row, Col, Empty, Spin, Button, Modal, Form, Input, InputNumber, message } from "antd";
import { ThunderboltOutlined, PlusOutlined } from "@ant-design/icons";
import { KPICard } from "@lions/ui";

interface PracticeItem {
  id: string;
  title: string;
  description: string | null;
  type: string;
  outcome: string;
  qualityScore: number | null;
  difficulty: number | null;
  duration: number | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sourceType: string | null;
  theme: string | null;
  skillLinks: Array<{ skill: { name: string; level: string } }>;
  knowledgeLinks: Array<{ knowledge: { title: string } }>;
}

const practiceSourceTypeLabel: Record<string, string> = {
  GLOBAL_ORGANIZER: "全局整理",
  PIPELINE_HERMES: "Hermes碎片",
  PIPELINE_AGENT_UT: "UT碎片",
  "PIPELINE_agent-h": "UT碎片",
  PIPELINE_CLAUDE: "Claude碎片",
  PRACTICE: "实践获得",
  LEARNING: "学习获得",
};

const practiceSourceTypeColor: Record<string, string> = {
  GLOBAL_ORGANIZER: "blue",
  PIPELINE_HERMES: "default",
  PIPELINE_AGENT_UT: "default",
  "PIPELINE_agent-h": "default",
  PIPELINE_CLAUDE: "default",
  PRACTICE: "green",
  LEARNING: "blue",
};

export default function PracticePage() {
  const [items, setItems] = useState<PracticeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [outcomeFilter, setOutcomeFilter] = useState<string | undefined>();
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<PracticeItem | null>(null);
  const [form] = Form.useForm();

  const fetchData = () => {
    setLoading(true);
    fetch("/api/trpc/practice.list?input=" + encodeURIComponent(JSON.stringify({ page: 1, pageSize: 100, sortBy: "updatedAt", sortOrder: "desc" })))
      .then((r) => r.json())
      .then((json) => setItems(json.result?.data?.items ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async (values: { title: string; description?: string; type: string; outcome: string; qualityScore?: number; difficulty?: number; duration?: number }) => {
    try {
      const res = await fetch("/api/trpc/practice.create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.result) {
        message.success("实践已记录");
        setCreateOpen(false);
        form.resetFields();
        fetchData();
      }
    } catch {
      message.error("创建失败");
    }
  };

  const outcomeColor = (outcome: string) => {
    const map: Record<string, string> = { SUCCESS: "green", PARTIAL: "orange", FAILED: "red", ABANDONED: "default" };
    return map[outcome] ?? "default";
  };

  const fmtTime = (v: string) => v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
  const columns = [
    { title: "标题", dataIndex: "title", key: "title", sorter: (a: PracticeItem, b: PracticeItem) => a.title.localeCompare(b.title), render: (v: string) => <span style={{ color: "var(--ink-primary)" }}>{v}</span> },
    { title: "类型", dataIndex: "type", key: "type", width: 90, sorter: (a: PracticeItem, b: PracticeItem) => a.type.localeCompare(b.type), render: (v: string) => <Tag>{v}</Tag> },
    { title: "来源", dataIndex: "sourceType", key: "sourceType", width: 90, sorter: (a: PracticeItem, b: PracticeItem) => (a.sourceType ?? "").localeCompare(b.sourceType ?? ""), render: (v: string | null) => v ? <Tag color={practiceSourceTypeColor[v] ?? "default"}>{practiceSourceTypeLabel[v] ?? v}</Tag> : "-" },
    { title: "结果", dataIndex: "outcome", key: "outcome", width: 70, sorter: (a: PracticeItem, b: PracticeItem) => a.outcome.localeCompare(b.outcome), render: (v: string) => <Tag color={outcomeColor(v)}>{v}</Tag> },
    { title: "质量", dataIndex: "qualityScore", key: "qualityScore", width: 55, sorter: (a: PracticeItem, b: PracticeItem) => (a.qualityScore ?? 0) - (b.qualityScore ?? 0), render: (v: number | null) => v ? `${v}/10` : "-" },
    { title: "难度", dataIndex: "difficulty", key: "difficulty", width: 55, sorter: (a: PracticeItem, b: PracticeItem) => (a.difficulty ?? 0) - (b.difficulty ?? 0), render: (v: number | null) => v ? `${v}/10` : "-" },
    { title: "创建时间", dataIndex: "createdAt", key: "createdAt", width: 120, sorter: (a: PracticeItem, b: PracticeItem) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(), render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", width: 120, sorter: (a: PracticeItem, b: PracticeItem) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(), defaultSortOrder: "descend" as const, render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{fmtTime(v)}</span> },
  ];

  const filtered = items.filter((p) => {
    if (typeFilter && p.type !== typeFilter) return false;
    if (outcomeFilter && p.outcome !== outcomeFilter) return false;
    if (sourceTypeFilter && p.sourceType !== sourceTypeFilter) return false;
    return true;
  });

  const successCount = items.filter((p) => p.outcome === "SUCCESS").length;
  const partialCount = items.filter((p) => p.outcome === "PARTIAL").length;
  const successRate = items.length > 0 ? Math.round((successCount / items.length) * 100) : 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: "var(--ink-primary)" }}><ThunderboltOutlined style={{ marginRight: 8 }} />实践与应用</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>记录实践</Button>
      </div>

      {/* 4 KPI — KPICard 改造 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={6}><KPICard label="总实践" value={items.length} tone="synapse" size="sm" /></Col>
        <Col span={6}><KPICard label="成功" value={successCount} tone="ok" size="sm" /></Col>
        <Col span={6}><KPICard label="部分成功" value={partialCount} tone="warn" size="sm" /></Col>
        <Col span={6}><KPICard label="成功率" value={successRate} suffix="%" tone="mind" size="sm" format="raw" /></Col>
      </Row>

      <div style={{ marginBottom: 16, display: "flex", gap: 12 }}>
        <Select placeholder="类型" allowClear style={{ width: 140 }} onChange={(v) => setTypeFilter(v)}
          options={["CODING_TASK", "BUG_FIX", "CODE_REVIEW", "DOC", "ARCHITECTURE", "DEBUG", "REFACTOR"].map((t) => ({ label: t, value: t }))} />
        <Select placeholder="来源" allowClear style={{ width: 130 }} onChange={(v) => setSourceTypeFilter(v)}
          options={Object.entries(practiceSourceTypeLabel).map(([k, v]) => ({ label: v, value: k }))} />
        <Select placeholder="结果" allowClear style={{ width: 120 }} onChange={(v) => setOutcomeFilter(v)}
          options={["SUCCESS", "PARTIAL", "FAILED", "ABANDONED"].map((o) => ({ label: o, value: o }))} />
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", height: 200, alignItems: "center" }}><Spin size="large" /></div>
      ) : filtered.length === 0 ? (
        <Empty description="暂无实践数据" />
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

      <Modal title="记录实践" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="记录" cancelText="取消" width={560}>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input placeholder="实践标题" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="实践内容描述..." />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={["CODING_TASK", "BUG_FIX", "CODE_REVIEW", "DOC", "ARCHITECTURE", "DEBUG", "REFACTOR"].map((t) => ({ label: t, value: t }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="outcome" label="结果" rules={[{ required: true }]}>
                <Select options={["SUCCESS", "PARTIAL", "FAILED", "ABANDONED"].map((o) => ({ label: o, value: o }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="qualityScore" label="质量评分">
                <InputNumber min={1} max={10} style={{ width: "100%" }} placeholder="1-10" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="difficulty" label="难度（1-10）">
                <InputNumber min={1} max={10} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="duration" label="时长（分钟）">
                <InputNumber min={1} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title="实践详情"
        open={detailOpen}
        onCancel={() => { setDetailOpen(false); setDetailItem(null); }}
        footer={null}
        width={600}
      >
        {detailItem ? (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Tag color={outcomeColor(detailItem.outcome)} style={{ fontSize: 13, padding: "2px 8px" }}>{detailItem.outcome}</Tag>
              <Tag color="geekblue">{detailItem.type}</Tag>
              {detailItem.theme && <Tag color="purple">{detailItem.theme}</Tag>}
              {detailItem.sourceType && <Tag color={practiceSourceTypeColor[detailItem.sourceType] ?? "default"}>{practiceSourceTypeLabel[detailItem.sourceType] ?? detailItem.sourceType}</Tag>}
              {detailItem.qualityScore && <span style={{ color: "var(--ink-primary)", fontSize: 13, marginLeft: 8 }}>质量: {detailItem.qualityScore}/10</span>}
            </div>
            <h3 style={{ color: "var(--ink-primary)", marginBottom: 12 }}>{detailItem.title}</h3>

            {detailItem.description && (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 4, fontSize: 12 }}>描述</div>
                <p style={{ color: "var(--ink-primary)", fontSize: 13, lineHeight: 1.6 }}>{detailItem.description}</p>
              </div>
            )}

            <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>统计信息</div>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 6, fontSize: 13 }}>
                <span style={{ color: "var(--ink-tertiary)" }}>难度：</span>
                <span style={{ color: "var(--ink-primary)" }}>{detailItem.difficulty ? `${detailItem.difficulty}/10` : "-"}</span>
                <span style={{ color: "var(--ink-tertiary)" }}>时长：</span>
                <span style={{ color: "var(--ink-primary)" }}>{detailItem.duration ? `${detailItem.duration}分钟` : "-"}</span>
                <span style={{ color: "var(--ink-tertiary)" }}>开始：</span>
                <span style={{ color: "var(--ink-primary)" }}>{new Date(detailItem.startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>
                {detailItem.completedAt && (
                  <>
                    <span style={{ color: "var(--ink-tertiary)" }}>完成：</span>
                    <span style={{ color: "var(--ink-primary)" }}>{new Date(detailItem.completedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>
                  </>
                )}
              </div>
            </div>

            {detailItem.skillLinks?.length > 0 && (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>关联技能</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {detailItem.skillLinks.map((l) => <Tag key={l.skill.name} color="purple">{l.skill.name} ({l.skill.level})</Tag>)}
                </div>
              </div>
            )}

            {detailItem.knowledgeLinks?.length > 0 && (
              <div style={{ background: "var(--surface)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "var(--brand-mind)", marginBottom: 8, fontSize: 12 }}>关联知识</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {detailItem.knowledgeLinks.map((l) => <Tag key={l.knowledge.title} color="geekblue">{l.knowledge.title}</Tag>)}
                </div>
              </div>
            )}

            <div style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>
              创建时间：{new Date(detailItem.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
