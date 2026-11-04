"use client";

import { useState, useEffect, useCallback } from "react";
import { useThemeColors } from "@/hooks/useThemeColors";
import {
  Card, Button, Row, Col, Typography, Tag, Space,
  InputNumber, Tooltip, message, Select, Statistic,
} from "antd";
import {
  PlayCircleOutlined, PauseCircleOutlined, ThunderboltOutlined,
  SaveOutlined, ReloadOutlined, HistoryOutlined, DatabaseOutlined,
  CalendarOutlined, RiseOutlined, ScheduleOutlined,
} from "@ant-design/icons";

const { Title, Text } = Typography;

interface RotationStatus {
  enabled: boolean;
  status: string;
  cronExpression: string;
  cronHumanReadable: string;
  maxPerRun: number;
  projectFilter: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  totalRuns: number;
  totalRecords: number;
  nextRunAt: string | null;
  isCurrentlyRunning: boolean;
  currentRunStartedAt: string | null;
}

interface TimelineEntry {
  date: string;
  recordsSynced: number;
  status: string;
  duration: number;
  sourceType: string;
}

// 北京时间格式化
function fmtBeijing(t: string | Date | null | undefined, withYear = false): string {
  if (!t) return "-";
  const d = typeof t === "string" ? new Date(t) : t;
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(withYear ? { year: "numeric" } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// 后端 cronToHuman 支持的 8 档 (engine.ts:21-30)
const CRON_OPTIONS = [
  { label: "每 5 分钟", value: "*/5 * * * *" },
  { label: "每 15 分钟", value: "*/15 * * * *" },
  { label: "每 30 分钟", value: "*/30 * * * *" },
  { label: "每小时", value: "0 * * * *" },
  { label: "每 2 小时", value: "0 */2 * * *" },
  { label: "每 6 小时", value: "0 */6 * * *" },
  { label: "每天 9:00", value: "0 9 * * *" },
  { label: "每天 9:00 和 18:00", value: "0 9,18 * * *" },
  { label: "每天午夜", value: "0 0 * * *" },
];

export default function RotationPage() {
  const C = useThemeColors();
  const [status, setStatus] = useState<RotationStatus | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cronExpr, setCronExpr] = useState("*/30 * * * *");
  const [maxPerRun, setMaxPerRun] = useState(3);
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // ─── Data fetching ────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/trpc/autoRotation.getStatus?input=%7B%7D");
      const json = await res.json();
      const s = json.result?.data;
      setStatus(s);
      if (s?.cronExpression) setCronExpr(s.cronExpression);
      if (s?.maxPerRun) setMaxPerRun(s.maxPerRun);
      if (s?.projectFilter) setProjectFilter(s.projectFilter);
    } catch { /* ignore */ }
  }, []);

  const fetchTimeline = useCallback(async () => {
    try {
      const res = await fetch("/api/trpc/autoRotation.getTimeline?input=%7B%7D");
      const json = await res.json();
      setTimeline(json.result?.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchTimeline();
  }, [fetchStatus, fetchTimeline]);

  // ─── Handlers ─────────────────────────────────────────────────────

  const handleStart = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/trpc/autoRotation.start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { cronExpression: cronExpr, maxPerRun, projectFilter: projectFilter || undefined } }),
      });
      await res.json();
      message.success("自动任务已启动");
      await fetchStatus();
    } catch { message.error("启动失败"); }
    finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/trpc/autoRotation.stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
      await res.json();
      message.success("自动任务已停止");
      await fetchStatus();
    } catch { message.error("停止失败"); }
    finally { setLoading(false); }
  };

  const handleRunNow = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/trpc/autoRotation.runNow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
      await res.json();
      message.success("立即运行已触发, 几分钟后刷新查看结果");
      setTimeout(async () => {
        await fetchStatus();
        await fetchTimeline();
      }, 5000);
    } catch { message.error("触发失败"); }
    finally { setLoading(false); }
  };

  // B14/B15 修复: 加 save 按钮, 调 updateConfig 端点
  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/trpc/autoRotation.updateConfig", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: {
            cronExpression: cronExpr,
            maxPerRun,
            projectFilter: projectFilter || undefined,
          },
        }),
      });
      const json = await res.json();
      if (json.error) {
        message.error("保存失败: " + json.error.message);
      } else {
        message.success("配置已保存 (不依赖启动按钮, RUNNING 状态也能改)");
        await fetchStatus();
        setEditing(false);
      }
    } catch { message.error("保存失败"); }
    finally { setSaving(false); }
  };

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24, background: "var(--bg-base)", minHeight: "100vh", color: "var(--ink-primary)" }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0, color: "var(--ink-primary)" }}>
          <ScheduleOutlined style={{ marginRight: 8, color: "var(--brand-mind)" }} />
          自动任务
        </Title>
        <Text type="secondary" style={{ marginTop: 4, display: "block" }}>
          skill 自动升级 + daily summary 自动生成 控制中心 (新增独立页面, 从 /pipeline 拆出)
        </Text>
      </div>

      {/* 状态卡 + 控制按钮 */}
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space>
            <ThunderboltOutlined spin={status?.isCurrentlyRunning} style={{ color: status ? (status.status === "RUNNING" ? C.statusOk : status.status === "IDLE" ? C.statusInfo : C.statusFrozen) : C.statusFrozen }} />
            <span>任务状态:</span>
            {status && (
              <Tag color={status.status === "RUNNING" ? "green" : status.status === "IDLE" ? "blue" : status.status === "ERROR" ? "red" : "default"}>
                {status.status === "RUNNING" ? "运行中" : status.status === "IDLE" ? "已调度" : status.status === "STOPPED" ? "已停止" : "异常"}
              </Tag>
            )}
          </Space>
        }
        extra={
          <Space>
            {!status?.enabled || status?.status === "STOPPED" ? (
              <Button type="primary" icon={<PlayCircleOutlined />} loading={loading} onClick={handleStart}>启动</Button>
            ) : (
              <Button danger icon={<PauseCircleOutlined />} loading={loading} onClick={handleStop}>停止</Button>
            )}
            <Button icon={<ThunderboltOutlined />} onClick={handleRunNow} disabled={!status?.enabled}>立即运行</Button>
            <Tooltip title={editing ? "取消编辑" : "编辑配置"}>
              <Button icon={<ScheduleOutlined />} onClick={() => setEditing(!editing)} />
            </Tooltip>
            <Tooltip title="刷新">
              <Button icon={<ReloadOutlined />} onClick={() => { fetchStatus(); fetchTimeline(); }} />
            </Tooltip>
          </Space>
        }
      >
        <Row gutter={16}>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 11 }}>调度周期</Text>
            <div style={{ color: "var(--brand-mind)", fontSize: 16, fontWeight: 600, marginTop: 4 }}>
              {status?.cronHumanReadable || "-"}
            </div>
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 11 }}>上次运行</Text>
            <div style={{ color: "var(--ink-secondary)", fontSize: 13, marginTop: 4 }}>
              {status?.lastRunAt ? fmtBeijing(status.lastRunAt) : "未运行"}
            </div>
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 11 }}>下次运行</Text>
            <div style={{ color: "var(--ink-secondary)", fontSize: 13, marginTop: 4 }}>
              {status?.nextRunAt ? fmtBeijing(status.nextRunAt) : "-"}
            </div>
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 11 }}>总运行 / 已提取</Text>
            <div style={{ color: "var(--ink-secondary)", fontSize: 13, marginTop: 4 }}>
              <span style={{ fontWeight: 600, color: "var(--brand-mind)" }}>{status?.totalRuns ?? 0}</span>
              <span style={{ color: "var(--ink-tertiary)" }}> 次 / </span>
              <span style={{ fontWeight: 600, color: "var(--brand-synapse)" }}>{status?.totalRecords ?? 0}</span>
              <span style={{ color: "var(--ink-tertiary)" }}> 条</span>
            </div>
          </Col>
        </Row>
        {status?.lastError && (
          <div style={{ marginTop: 12, padding: 8, background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>最近错误:</Text>
            <div style={{ color: "var(--status-err)", fontSize: 12, marginTop: 2, wordBreak: "break-all" }}>
              {status.lastError}
            </div>
          </div>
        )}
      </Card>

      {/* B14/B15 修复: 配置编辑 + save 按钮 */}
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space>
            <span>⚙️ 配置</span>
            <Tag color="green" style={{ fontSize: 10 }}>B14/B15 修复</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>
              (暴露 updateConfig 端点 + save 按钮 + 9 档 cron)
            </Text>
          </Space>
        }
      >
        <Row gutter={[24, 16]}>
          <Col span={8}>
            <Text type="secondary" style={{ fontSize: 11 }}>Cron 表达式</Text>
            <Select
              value={cronExpr}
              onChange={setCronExpr}
              disabled={!editing}
              style={{ width: "100%", marginTop: 4 }}
              options={CRON_OPTIONS}
            />
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 11 }}>每次最大处理数</Text>
            <InputNumber
              min={1}
              max={20}
              value={maxPerRun}
              onChange={(v) => v && setMaxPerRun(v)}
              disabled={!editing}
              style={{ width: "100%", marginTop: 4 }}
            />
          </Col>
          <Col span={6}>
            <Text type="secondary" style={{ fontSize: 11 }}>项目过滤 (可选)</Text>
            <input
              className="ant-input"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              disabled={!editing}
              placeholder="如: ut-only"
              style={{ width: "100%", marginTop: 4, padding: "4px 11px", background: "var(--bg-base)", color: "var(--ink-primary)", border: "1px solid var(--border-hi)", borderRadius: 4 }}
            />
          </Col>
          <Col span={4}>
            <Text type="secondary" style={{ fontSize: 11 }}>&nbsp;</Text>
            <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
              {editing ? (
                <>
                  <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSaveConfig} block>
                    保存
                  </Button>
                  <Button onClick={() => { setEditing(false); fetchStatus(); }}>取消</Button>
                </>
              ) : (
                <Button icon={<ScheduleOutlined />} onClick={() => setEditing(true)} block>编辑</Button>
              )}
            </div>
          </Col>
        </Row>
        {editing && (
          <div style={{ marginTop: 8, padding: 8, background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: 4, fontSize: 11, color: "var(--status-ok)" }}>
            ✅ 编辑模式: 改完点&quot;保存&quot;按钮, 调 autoRotation.updateConfig 端点. 不依赖&quot;启动&quot;按钮, RUNNING 状态也能改.
          </div>
        )}
      </Card>

      {/* 死端点暴露: 5 卡片 (1 行等宽布局, 避免 2x3 留空) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Card
          size="small"
          title={
            <Space>
              <HistoryOutlined />
              <span>历史摘要</span>
              <Tag color="green" style={{ fontSize: 10 }}>查询</Tag>
            </Space>
          }
          extra={
            <Button size="small" icon={<ReloadOutlined />}
              onClick={async () => {
                try {
                  const r = await fetch("/api/trpc/autoRotation.getDailySummaries?input=%7B%7D");
                  const j = await r.json();
                  const list = j.result?.data ?? [];
                  message.success(`找到 ${list.length} 条 daily summary`);
                } catch { message.error("查询失败"); }
              }}
            >查询</Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 11 }}>
            端点: <code style={{ fontSize: 10 }}>getDailySummaries</code>
          </Text>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <ThunderboltOutlined />
              <span>今日生成</span>
              <Tag color="blue" style={{ fontSize: 10 }}>触发</Tag>
            </Space>
          }
          extra={
            <Button size="small" type="primary" icon={<ThunderboltOutlined />}
              onClick={async () => {
                try {
                  const r = await fetch("/api/trpc/autoRotation.generateDailySummary", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ json: {} }),
                  });
                  const j = await r.json();
                  if (j.result?.data) message.success("今日总结已生成");
                } catch { message.error("生成失败"); }
              }}
            >生成</Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 11 }}>
            端点: <code style={{ fontSize: 10 }}>generateDailySummary</code>
          </Text>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <ScheduleOutlined />
              <span>摘要调度</span>
              <Tag color="purple" style={{ fontSize: 10 }}>调度</Tag>
            </Space>
          }
          extra={
            <Button size="small" icon={<ThunderboltOutlined />}
              onClick={async () => {
                try {
                  const r = await fetch("/api/trpc/autoRotation.startDailySummaryScheduler", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ json: {} }),
                  });
                  await r.json();
                  message.success("已启动");
                } catch { message.error("调用失败"); }
              }}
            >启动</Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 11 }}>
            端点: <code style={{ fontSize: 10 }}>startDailySummaryScheduler</code>
          </Text>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <RiseOutlined />
              <span>技能升级</span>
              <Tag color="purple" style={{ fontSize: 10 }}>调度</Tag>
            </Space>
          }
          extra={
            <Button size="small" icon={<ThunderboltOutlined />}
              onClick={async () => {
                try {
                  const r = await fetch("/api/trpc/autoRotation.startSkillUpgradeScheduler", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ json: {} }),
                  });
                  await r.json();
                  message.success("已启动");
                } catch { message.error("调用失败"); }
              }}
            >启动</Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 11 }}>
            端点: <code style={{ fontSize: 10 }}>startSkillUpgradeScheduler</code>
          </Text>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <DatabaseOutlined />
              <span>数据分布</span>
              <Tag color="green" style={{ fontSize: 10 }}>查询</Tag>
            </Space>
          }
          extra={
            <Button size="small" icon={<ReloadOutlined />}
              onClick={async () => {
                try {
                  const r = await fetch("/api/trpc/autoRotation.getDistribution?input=%7B%7D");
                  const j = await r.json();
                  const d = j.result?.data ?? {};
                  message.success(`记忆 ${d.memories || 0} / 知识 ${d.knowledge || 0} / 反思 ${d.reflections || 0} / 实践 ${d.practices || 0}`);
                } catch { message.error("查询失败"); }
              }}
            >查询</Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 11 }}>
            端点: <code style={{ fontSize: 10 }}>getDistribution</code>
          </Text>
        </Card>
      </div>

      {/* Timeline 历史 (最多 10 条) */}
      <Card
        size="small"
        title={
          <Space>
            <HistoryOutlined />
            <span>任务历史 (最近 10 条)</span>
            <Tag color="cyan">{timeline.length} 条</Tag>
          </Space>
        }
      >
        {timeline.length > 0 ? (
          <div>
            {timeline.slice(0, 10).map((t, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < 9 ? "1px solid var(--border-soft)" : "none" }}>
                <Space>
                  <Text style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>{fmtBeijing(t.date)}</Text>
                  <Tag color={t.status === "COMPLETED" ? "green" : t.status === "FAILED" ? "red" : "orange"}>
                    {t.status === "COMPLETED" ? "成功" : t.status === "FAILED" ? "失败" : "进行中"}
                  </Tag>
                  <Tag color="blue">{t.sourceType}</Tag>
                </Space>
                <Text style={{ fontSize: 12 }}>
                  提取 <span style={{ color: "var(--brand-synapse)", fontWeight: 600 }}>{t.recordsSynced}</span> 条
                </Text>
              </div>
            ))}
          </div>
        ) : (
          <Text type="secondary">暂无任务历史</Text>
        )}
      </Card>
    </div>
  );
}
