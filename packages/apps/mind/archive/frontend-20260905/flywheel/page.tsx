"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Row, Col, Spin, Empty, Table, Tag, Tabs, Button, message, Statistic, Progress } from "antd";
import { SyncOutlined, CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined, ExperimentOutlined, ThunderboltOutlined, ClusterOutlined } from "@ant-design/icons";
import { KPICard, BigNumber, StatusPill } from "@lions/ui";

// ===== 类型 =====
interface Metrics {
  metrics: {
    duplicateQuestionRate: number;
    answerAccuracyRate: number;
    contextMissingAlerts: number;
    preferenceAutoApplyRate: number;
  };
  engineering: {
    totalReflections: number;
    okReflections: number;
    okRate: number;
    pendingImprovingTasks: number;
    structuredMemories: number;
    activeThemes: number;
  };
  trend: Array<{ date: string; reflections: number; improvingTasks: number; structured: number }>;
}

interface Reflection {
  id: string; theme: string; status: string;
  coverageScore: number; missedTopics: string[];
  improvements: string[];
  createdAt: string;
}

interface ImprovingTask {
  id: string; title: string; status: string;
  improvementType: string; theme: string;
  manualReview: boolean; createdAt: string;
}

interface StructuredItem {
  id: string; title: string; theme: string;
  content: string; createdAt: string;
}

// ===== API helpers =====
async function api<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const STATUS_COLOR: Record<string, string> = {
  OK: "green", DONE: "green", SKIPPED: "orange",
  FAILED: "red", PENDING: "blue", PROCESSING: "cyan",
};

// ===== 主组件 =====
export default function FlywheelPage() {
  const [tab, setTab] = useState("overview");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reflections, setReflections] = useState<Reflection[]>([]);
  const [tasks, setTasks] = useState<ImprovingTask[]>([]);
  const [structured, setStructured] = useState<StructuredItem[]>([]);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async (t: string) => {
    setLoading(true);
    try {
      if (t === "overview") {
        setMetrics(await api<Metrics>("/api/v1/flywheel/metrics"));
      } else if (t === "reflections") {
        const d = await api<{ items: Reflection[]; total: number }>("/api/v1/flywheel/reflections?limit=50");
        setReflections(d.items || []);
      } else if (t === "tasks") {
        const d = await api<{ tasks: ImprovingTask[] }>("/api/v1/flywheel/improving-tasks?limit=50");
        setTasks(d.tasks || []);
      } else if (t === "structured") {
        const d = await api<{ items: StructuredItem[] }>("/api/v1/flywheel/structured?limit=50");
        setStructured(d.items || []);
      }
    } catch (e: any) {
      message.error(`加载失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(tab); }, [tab, loadData]);

  // 手动触发 cron
  const triggerCron = async (type: string) => {
    message.loading({ content: `${type} cron 执行中...`, key: "cron", duration: 0 });
    try {
      await api(`/api/v1/flywheel/${type}/cron`);
      message.success({ content: `${type} cron 完成`, key: "cron" });
      loadData(tab);
    } catch (e: any) {
      message.error({ content: `${type} cron 失败: ${e.message}`, key: "cron" });
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "overview", label: <span><ExperimentOutlined /> 总览</span> },
          { key: "reflections", label: <span><ClusterOutlined /> 反思 (V1.5)</span> },
          { key: "tasks", label: <span><ThunderboltOutlined /> 改进任务 (V1.6)</span> },
          { key: "structured", label: <span><SyncOutlined /> 结构化 (V1.7)</span> },
        ]}
      />

      <Spin spinning={loading}>
        {tab === "overview" && metrics && (
          <div>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={6}>
                <KPICard title="回答准确率" value={`${(metrics.metrics.answerAccuracyRate * 100).toFixed(1)}%`} />
              </Col>
              <Col span={6}>
                <KPICard title="上下文缺失提醒" value={`${metrics.metrics.contextMissingAlerts} 次/周`} />
              </Col>
              <Col span={6}>
                <KPICard title="偏好自动应用" value={`${metrics.metrics.preferenceAutoApplyRate} 次/周`} />
              </Col>
              <Col span={6}>
                <KPICard title="重复提问率" value={`${(metrics.metrics.duplicateQuestionRate * 100).toFixed(1)}%`} />
              </Col>
            </Row>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={4}><Statistic title="总反思" value={metrics.engineering.totalReflections} /></Col>
              <Col span={4}><Statistic title="OK 反思" value={metrics.engineering.okReflections} /></Col>
              <Col span={4}>
                <div>OK 率</div>
                <Progress percent={metrics.engineering.okRate} size="small" />
              </Col>
              <Col span={4}><Statistic title="待处理任务" value={metrics.engineering.pendingImprovingTasks} /></Col>
              <Col span={4}><Statistic title="结构化 Memory" value={metrics.engineering.structuredMemories} /></Col>
              <Col span={4}><Statistic title="活跃主题" value={metrics.engineering.activeThemes} /></Col>
            </Row>
            <Card title="Cron 手动触发" size="small" style={{ marginBottom: 16 }}>
              <Button.Group>
                <Button icon={<ExperimentOutlined />} onClick={() => triggerCron("reflections")}>V1.5 反思</Button>
                <Button icon={<ThunderboltOutlined />} onClick={() => triggerCron("improving-tasks")}>V1.6 改进</Button>
                <Button icon={<SyncOutlined />} onClick={() => triggerCron("structured")}>V1.7 结构化</Button>
              </Button.Group>
            </Card>
            {metrics.trend.length > 0 && (
              <Card title="7 天趋势" size="small">
                <Table
                  size="small"
                  pagination={false}
                  dataSource={metrics.trend}
                  rowKey="date"
                  columns={[
                    { title: "日期", dataIndex: "date", key: "date" },
                    { title: "反思", dataIndex: "reflections", key: "reflections" },
                    { title: "改进任务", dataIndex: "improvingTasks", key: "improvingTasks" },
                    { title: "结构化", dataIndex: "structured", key: "structured" },
                  ]}
                />
              </Card>
            )}
          </div>
        )}

        {tab === "reflections" && (
          <Table
            size="small"
            dataSource={reflections}
            rowKey="id"
            columns={[
              { title: "主题", dataIndex: "theme", key: "theme", width: 200 },
              { title: "状态", dataIndex: "status", key: "status", width: 100, render: (s: string) => <Tag color={STATUS_COLOR[s] || "default"}>{s}</Tag> },
              { title: "覆盖率", dataIndex: "coverageScore", key: "coverageScore", width: 120, render: (v: number) => <Progress percent={v * 100} size="small" /> },
              { title: "遗漏项", key: "missed", width: 80, render: (_: any, r: Reflection) => r.missedTopics?.length || 0 },
              { title: "改进项", key: "improvements", width: 80, render: (_: any, r: Reflection) => r.improvements?.length || 0 },
              { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 180, render: (t: string) => t?.slice(0, 19).replace("T", " ") },
            ]}
          />
        )}

        {tab === "tasks" && (
          <Table
            size="small"
            dataSource={tasks}
            rowKey="id"
            columns={[
              { title: "标题", dataIndex: "title", key: "title", ellipsis: true },
              { title: "类型", dataIndex: "improvementType", key: "type", width: 120, render: (t: string) => <Tag>{t}</Tag> },
              { title: "主题", dataIndex: "theme", key: "theme", width: 150, ellipsis: true },
              { title: "状态", dataIndex: "status", key: "status", width: 100, render: (s: string) => <Tag color={STATUS_COLOR[s] || "default"}>{s}</Tag> },
              { title: "人审", dataIndex: "manualReview", key: "review", width: 80, render: (v: boolean) => v ? <Tag color="orange">需审</Tag> : <Tag color="green">自动</Tag> },
              { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 180, render: (t: string) => t?.slice(0, 19).replace("T", " ") },
            ]}
          />
        )}

        {tab === "structured" && (
          <Table
            size="small"
            dataSource={structured}
            rowKey="id"
            columns={[
              { title: "标题", dataIndex: "title", key: "title", width: 250, ellipsis: true },
              { title: "主题", dataIndex: "theme", key: "theme", width: 150 },
              { title: "内容摘要", dataIndex: "content", key: "content", ellipsis: true, render: (c: string) => c?.slice(0, 100) },
              { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 180, render: (t: string) => t?.slice(0, 19).replace("T", " ") },
            ]}
          />
        )}

        {loading === false && (
          (tab === "reflections" && reflections.length === 0) ||
          (tab === "tasks" && tasks.length === 0) ||
          (tab === "structured" && structured.length === 0)
        ) && <Empty description="暂无数据" />}
      </Spin>
    </div>
  );
}
