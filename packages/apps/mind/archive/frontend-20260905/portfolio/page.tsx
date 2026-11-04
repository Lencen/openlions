"use client";

import { useState, useEffect } from "react";
import { Card, Table, Tag, Select, Row, Col, Statistic, Empty, Spin, Button, Modal, Form, Input, InputNumber, message } from "antd";
import { TrophyOutlined, PlusOutlined } from "@ant-design/icons";
import { KPICard } from "@lions/ui";

interface OutputItem {
  id: string;
  title: string;
  type: string;
  quality: string;
  qualityScore: number | null;
  projectId: string | null;
  gitCommitHash: string | null;
  filePaths: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  createdAt: string;
}

export default function PortfolioPage() {
  const [items, setItems] = useState<OutputItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<OutputItem | null>(null);
  const [form] = Form.useForm();

  const fetchData = () => {
    setLoading(true);
    fetch("/api/trpc/portfolio.list?input=" + encodeURIComponent(JSON.stringify({ page: 1, pageSize: 100 })))
      .then((r) => r.json())
      .then((json) => setItems(json.result?.data?.items ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async (values: { title: string; type: string; quality: string; qualityScore?: number; projectId?: string; gitCommitHash?: string; linesAdded?: number; linesRemoved?: number }) => {
    try {
      const res = await fetch("/api/trpc/portfolio.create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.result) {
        message.success("成果已记录");
        setCreateOpen(false);
        form.resetFields();
        fetchData();
      }
    } catch {
      message.error("创建失败");
    }
  };

  const qualityColor = (quality: string) => {
    const map: Record<string, string> = { EXCEPTIONAL: "gold", GOOD: "green", ADEQUATE: "blue", NEEDS_WORK: "orange" };
    return map[quality] ?? "default";
  };

  const columns = [
    { title: "标题", dataIndex: "title", key: "title", render: (v: string) => <span style={{ color: "var(--ink-primary)", fontWeight: 500 }}>{v}</span> },
    { title: "类型", dataIndex: "type", key: "type", width: 120, render: (v: string) => <Tag>{v}</Tag> },
    { title: "质量", dataIndex: "quality", key: "quality", width: 100, render: (v: string) => <Tag color={qualityColor(v)}>{v}</Tag> },
    { title: "评分", dataIndex: "qualityScore", key: "qualityScore", width: 60, render: (v: number | null) => v ? `${v}/10` : "-" },
    { title: "项目", dataIndex: "projectId", key: "projectId", width: 120, render: (v: string | null) => v ? <Tag color="geekblue">{v}</Tag> : "-" },
    { title: "代码量", key: "lines", width: 120, render: (_: unknown, r: OutputItem) => r.linesAdded != null ? <span style={{ color: "var(--status-ok)" }}>+{r.linesAdded}</span> : r.linesRemoved != null ? <span style={{ color: "var(--status-err)" }}>-{r.linesRemoved}</span> : "-" },
    { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 100, render: (v: string) => <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>{new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</span> },
  ];

  const filtered = items.filter((o) => !typeFilter || o.type === typeFilter);
  const exceptional = items.filter((o) => o.quality === "EXCEPTIONAL").length;
  const good = items.filter((o) => o.quality === "GOOD").length;
  const avgQuality = items.length > 0 ? items.reduce((s, o) => s + (o.qualityScore ?? 0), 0) / items.length : 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: "var(--ink-primary)" }}><TrophyOutlined style={{ marginRight: 8 }} />成果与输出</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>记录成果</Button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <KPICard label="总产出" value={items.length} tone="flow" />
        <KPICard label="杰出" value={exceptional} tone="synapse" sub="EXCEPTIONAL" />
        <KPICard label="良好" value={good} tone="ok" sub="GOOD" />
        <KPICard label="平均质量" value={avgQuality} tone="mind" format="raw" precision={1} suffix="/10" />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Select placeholder="类型" allowClear style={{ width: 140 }} onChange={(v) => setTypeFilter(v)}
          options={["CODE_COMMIT", "PR", "DOCUMENTATION", "DESIGN_SPEC", "BUG_FIX", "FEATURE"].map((t) => ({ label: t, value: t }))} />
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", height: 200, alignItems: "center" }}><Spin size="large" /></div>
      ) : filtered.length === 0 ? (
        <Empty description="暂无成果数据" />
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

      <Modal title="记录成果" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="记录" cancelText="取消" width={560}>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input placeholder="成果标题" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={["CODE_COMMIT", "PR", "DOCUMENTATION", "DESIGN_SPEC", "BUG_FIX", "FEATURE"].map((t) => ({ label: t, value: t }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="quality" label="质量" rules={[{ required: true }]}>
                <Select options={[{ label: "EXCEPTIONAL", value: "EXCEPTIONAL" }, { label: "GOOD", value: "GOOD" }, { label: "ADEQUATE", value: "ADEQUATE" }, { label: "NEEDS_WORK", value: "NEEDS_WORK" }]} />
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
              <Form.Item name="projectId" label="项目ID">
                <Input placeholder="项目标识" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="gitCommitHash" label="Git Commit">
                <Input placeholder="commit hash" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="linesAdded" label="新增行数">
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="linesRemoved" label="删除行数">
                <InputNumber min={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title="成果详情"
        open={detailOpen}
        onCancel={() => { setDetailOpen(false); setDetailItem(null); }}
        footer={null}
        width={560}
      >
        {detailItem ? (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Tag color={qualityColor(detailItem.quality)} style={{ fontSize: 13, padding: "2px 8px" }}>{detailItem.quality}</Tag>
              <Tag color="geekblue">{detailItem.type}</Tag>
              {detailItem.qualityScore && <span style={{ color: "#e8e8e8", fontSize: 13, marginLeft: 8 }}>评分: {detailItem.qualityScore}/10</span>}
            </div>
            <h3 style={{ color: "#e8e8e8", marginBottom: 12 }}>{detailItem.title}</h3>

            <div style={{ background: "rgba(255,255,255,0.03)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "#667eea", marginBottom: 8, fontSize: 12 }}>项目信息</div>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 6, fontSize: 13 }}>
                {detailItem.projectId && (
                  <>
                    <span style={{ color: "#a0a0b0" }}>项目ID：</span>
                    <span style={{ color: "#e8e8e8", fontSize: 11, wordBreak: "break-all" }}>{detailItem.projectId}</span>
                  </>
                )}
                {detailItem.gitCommitHash && (
                  <>
                    <span style={{ color: "#a0a0b0" }}>Commit：</span>
                    <span style={{ color: "#e8e8e8", fontSize: 11, wordBreak: "break-all" }}>{detailItem.gitCommitHash}</span>
                  </>
                )}
                {detailItem.filePaths && (
                  <>
                    <span style={{ color: "#a0a0b0" }}>文件：</span>
                    <span style={{ color: "#e8e8e8", fontSize: 11, wordBreak: "break-all" }}>{detailItem.filePaths}</span>
                  </>
                )}
              </div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.03)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: "#667eea", marginBottom: 8, fontSize: 12 }}>代码统计</div>
              <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                {detailItem.linesAdded != null && <div><span style={{ color: "#a0a0b0" }}>新增：</span><span style={{ color: "#52c41a" }}>+{detailItem.linesAdded} 行</span></div>}
                {detailItem.linesRemoved != null && <div><span style={{ color: "#a0a0b0" }}>删除：</span><span style={{ color: "#ff4d4f" }}>-{detailItem.linesRemoved} 行</span></div>}
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#a0a0b0" }}>
              创建时间：{new Date(detailItem.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
