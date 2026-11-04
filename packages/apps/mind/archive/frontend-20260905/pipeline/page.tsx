"use client";

import { useState, useEffect, useCallback } from "react";
import { useThemeColors } from "@/hooks/useThemeColors";
import {
  Card, Button, Row, Col, Typography, Tag, Space,
  InputNumber, Tooltip, message, Empty, Spin, Table,
  Modal, Descriptions, Switch, Tabs, Select,
} from "antd";
import {
  PlayCircleOutlined, PauseCircleOutlined, ThunderboltOutlined,
  SyncOutlined, SettingOutlined, ReloadOutlined,
  ScanOutlined, DatabaseOutlined, PieChartOutlined,
  TeamOutlined, ApiOutlined,
} from "@ant-design/icons";
import dynamic from "next/dynamic";
import * as echarts from "echarts/core";
import { BarChart, PieChart } from "echarts/charts";
import {
  TooltipComponent, GridComponent, LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { KPICard } from "@lions/ui";
import { StatusPill } from "@lions/ui";
import { FlywheelDashboard } from "./FlywheelDashboard";

echarts.use([
  BarChart, PieChart, TooltipComponent, GridComponent,
  LegendComponent, CanvasRenderer,
]);

const ReactECharts = dynamic(
  () => import("echarts-for-react/lib/core"),
  { ssr: false }
);

const { Title, Text } = Typography;

const statusColor: Record<string, string> = {
  RUNNING: "var(--status-ok)",
  IDLE: "var(--status-info)",
  STOPPED: "var(--status-frozen)",
  ERROR: "var(--status-err)",
};

// ─── Shared interfaces ───────────────────────────────────────────────

interface PipelineStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalRecordsExtracted: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

interface RunResult {
  success: boolean;
  processed: number;
  totalRecordsCreated: number;
  errors: Array<{ sessionId: string; error: string }>;
  summary: Array<{
    sessionId: string; title: string; summary: string;
    stats: {
      memoriesCreated: number; knowledgeCreated: number;
      reflectionsCreated: number; practicesCreated: number;
      skillsCreated: number; flywheelEventsCreated: number;
    };
  }>;
  runId?: string;
}

interface HistoryEntry {
  id: string;
  sourceType: string;
  sourcePath: string;
  status: string;
  recordsSynced: number;
  recordsSkipped: number;
  messageCount: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  agent_id?: string;  // B16+ 关联 agent
}

interface AgentPipeline {
  agent_id: string;
  display_name: string;
  channel: string;
  host: string;
  last_seen_at: string | null;
  sessions_24h: number;
  memory_count: number;
  knowledge_count: number;
  reflection_count: number;
  service_count: number;
  services: Array<{
    service_name: string;
    endpoint: string;
    expires_at: string | null;
    last_used_at: string | null;
  }>;
}

// ─── Constants ──────────────────────────────────────────────────────

const statusLabel: Record<string, string> = {
  RUNNING: "运行中", IDLE: "已调度", STOPPED: "已停止", ERROR: "异常",
};

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

const historyColumns = [
  { title: "时间", dataIndex: "uploaded_at", key: "uploaded_at", width: 150, sorter: (a: any, b: any) => (a.uploaded_at || "").localeCompare(b.uploaded_at || ""), defaultSortOrder: "descend" as const,
    render: (t: string) => fmtBeijing(t) },
  { title: "Agent", dataIndex: "agent_id", key: "agent_id", width: 110, sorter: (a: any, b: any) => (a.agent_id || "").localeCompare(b.agent_id || ""),
    render: (v: string) => <Tag color="cyan">{v || "-"}</Tag> },
  { title: "会话 UID", dataIndex: "session_uid", key: "session_uid", width: 200,
    render: (t: string) => <Text ellipsis style={{ maxWidth: 180 }}>{t}</Text> },
  { title: "标题", dataIndex: "title", key: "title",
    render: (t: string) => <Text ellipsis style={{ maxWidth: 200 }}>{t || "-"}</Text> },
  { title: "状态", dataIndex: "status", key: "status", width: 90, sorter: (a: any, b: any) => (a.status || "").localeCompare(b.status || ""),
    render: (v: string) => {
      const colorMap: Record<string,string> = {"PENDING":"orange","PROCESSED":"green","PROCESSING":"blue","FAILED":"red","SKIPPED":"default","NEEDS_RAW":"volcano"};
      const labelMap: Record<string,string> = {"PENDING":"待提取","PROCESSED":"已提取","PROCESSING":"提取中","FAILED":"失败","SKIPPED":"跳过","NEEDS_RAW":"缺数据"};
      return <Tag color={colorMap[v] || "default"}>{labelMap[v] || v}</Tag>;
    } },
  { title: "消息数", dataIndex: "message_count", key: "message_count", width: 80, sorter: (a: any, b: any) => (a.message_count || 0) - (b.message_count || 0),
    render: (v: number) => v > 0 ? <Tag color="blue">{v}</Tag> : "-" },
  { title: "错误", dataIndex: "processing_error", key: "processing_error",
    render: (t: string | null) => t ? <Text type="danger" ellipsis style={{ maxWidth: 150 }}>{t}</Text> : "-" },
];

// ─── Main Page ──────────────────────────────────────────────────────

export default function PipelinePage() {
  const C = useThemeColors();
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);  // B13 修复: 之前从未 setHistory()
  const [agents, setAgents] = useState<AgentPipeline[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<string | null>(null);  // 按 agent 触发,记录哪个 agent 在跑
  const [maxConvs, setMaxConvs] = useState(5);

  // ─── Global Organizer state ─────────────────────────────────────
  const [goGroupKey, setGoGroupKey] = useState("");
  const [goTaskId, setGoTaskId] = useState<string | null>(null);
  const [goStatus, setGoStatus] = useState<any>(null);
  const [goPolling, setGoPolling] = useState(false);

  // ─── Data fetching ────────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/trpc/sessionRegistry.stats`);
      const json = await res.json();
      return json.result?.data;
    } catch { return null; }
  }, []);

  // B13 修复: 改 take:50 → take:200 + 加 setHistory 4 处
  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/trpc/sessionRegistry.list?input=${encodeURIComponent(JSON.stringify({limit:200,sortBy:"updated_at",sortOrder:"desc"}))}`);
      const json = await res.json();
      const items = json.result?.data?.items ?? [];
      setHistory(items);
      return items;
    } catch { return []; }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/trpc/sessionRegistry.byAgent");
      const json = await res.json();
      const raw = json.result?.data;
      const list = Array.isArray(raw) ? raw : (raw?.agents ?? []);
      setAgents(list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    (async () => {
      const s = await fetchStats();
      if (s) setStats(s);
      await fetchHistory();  // ✅ setHistory 在内部
      await fetchAgents();
    })();
  }, [fetchStats, fetchHistory, fetchAgents]);

  // ─── Handlers ─────────────────────────────────────────────────────

  // 按 agent 触发管道 (4 卡片每张一个按钮)
  const handleRunAgent = async (agentId: string) => {
    setRunning(agentId);
    setLoading(true);
    try {
      const res = await fetch("/api/trpc/sessionRegistry.processPipeline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { limit: maxConvs, dryRun: false, agentId } }),
      });
      const json = await res.json();
      if (json.error) {
        message.error(`[${agentId}] ${json.error.message || "请求失败"}`, 8);
        return;
      }
      const result = json.result.data;
      const claimed = result.claimed ?? 0;
      const processed = result.processed ?? 0;
      const failed = result.failed ?? 0;
      const skipped = result.skipped ?? 0;
      const totalRecs = (result.results || []).reduce((s:number,r:any) => s + (r.recordsCreated || 0), 0);
      if (failed > 0) {
        const errDetails = (result.results || []).filter((r:any) => r.status === "FAILED").map((r:any) => `${r.sessionUid?.slice(-20)}: ${r.error || "未知"}`).join("; ");
        message.warning(`[${agentId}] 处理 ${processed} 成功, ${failed} 失败${errDetails ? ': ' + errDetails : ''}, ${skipped} 跳过, 提取 ${totalRecs} 条`, 10);
      } else {
        message.success(`[${agentId}] 处理 ${processed} 成功, ${skipped} 跳过, 提取 ${totalRecs} 条`);
      }
      const s = await fetchStats();
      if (s) setStats(s);
      await fetchHistory();
      await fetchAgents();
    } catch (e) {
      message.error(`[${agentId}] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
      setLoading(false);
    }
  };

  // B19 修复: 一键处理全部 4 agent 管道
  const handleRunAllAgents = async () => {
    if (agents.length === 0) {
      message.warning("暂无 agent 接入, 无可处理");
      return;
    }
    setRunning("ALL");
    setLoading(true);
    try {
      const results: any[] = [];
      for (const a of agents) {
        const res = await fetch("/api/trpc/sessionRegistry.processPipeline", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { limit: maxConvs, dryRun: false, agentId: a.agent_id } }),
        });
        const json = await res.json();
        if (!json.error && json.result?.data) {
          results.push({ agentId: a.agent_id, ...json.result.data });
        }
      }
      const totalProcessed = results.reduce((s,r) => s + (r.processed||0), 0);
      const totalFailed = results.reduce((s,r) => s + (r.failed||0), 0);
      const totalRecs = results.reduce((s,r) => s + (r.results||[]).reduce((a:number,x:any)=>a+(x.recordsCreated||0),0), 0);
      if (totalFailed > 0) {
        message.warning(`✅ 一键处理完成: ${totalProcessed} 成功, ${totalFailed} 失败, 提取 ${totalRecs} 条 (${results.length} agents)`);
      } else {
        message.success(`✅ 一键处理完成: ${totalProcessed} 成功, 提取 ${totalRecs} 条 (${results.length} agents)`);
      }
      const s = await fetchStats();
      if (s) setStats(s);
      await fetchHistory();
      await fetchAgents();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      message.error(`一键处理失败: ${errMsg}`);
    } finally {
      setRunning(null);
      setLoading(false);
    }
  };

  // ─── Global Organizer handlers ─────────────────────────────────

  const pollGoStatus = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(`/api/v1/global-organizer/status/${taskId}`);
      if (!res.ok) return;
      const data = await res.json();
      setGoStatus(data);
      if (data.status === "RUNNING" || data.status === "STARTED") {
        setTimeout(() => pollGoStatus(taskId), 3000);
      } else {
        setGoPolling(false);
      }
    } catch { /* ignore */ }
  }, []);

  const handleGoRun = async () => {
    if (!goGroupKey.trim()) {
      message.warning("请输入 groupKey");
      return;
    }
    setGoPolling(true);
    setGoStatus(null);
    try {
      const res = await fetch("/api/v1/global-organizer/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupKey: goGroupKey.trim() }),
      });
      const json = await res.json();
      if (json.error) {
        message.error(json.error);
        setGoPolling(false);
        return;
      }
      setGoTaskId(json.taskId);
      message.info(`已启动: ${json.taskId}`);
      pollGoStatus(json.taskId);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setGoPolling(false);
    }
  };

  const handleGoRunAll = async () => {
    setGoPolling(true);
    setGoStatus(null);
    try {
      const res = await fetch("/api/v1/global-organizer/run-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "PENDING", limit: 3 }),
      });
      const json = await res.json();
      if (json.error) {
        message.error(json.error);
        setGoPolling(false);
        return;
      }
      message.success(`已排队 ${json.totalQueued} 个 group`);
      if (json.tasks?.[0]?.taskId) {
        setGoTaskId(json.tasks[0].taskId);
        pollGoStatus(json.tasks[0].taskId);
      } else {
        setGoPolling(false);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setGoPolling(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24, background: "var(--bg-base)", minHeight: "100vh", color: "var(--ink-primary)" }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0, color: "var(--ink-primary)" }}>
          <ThunderboltOutlined style={{ marginRight: 8, color: "var(--brand-mind)" }} />
          认知管道 (Cognitive Pipeline)
        </Title>
        <Text type="secondary" style={{ marginTop: 4, display: "block" }}>
          按接入 agent 维度管理管道 — 每个 agent 独立触发 + 独立统计 (业务目标: 4 agent × 独立管道)
        </Text>
      </div>

      {/* Top Stats Row —4 KPI */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <KPICard label="总会话" value={(stats as any)?.total ?? 0} tone="mind" sub="条" />
        <KPICard label="待提取" value={(stats as any)?.byStatus?.PENDING ?? 0} tone="synapse" icon="⏳" />
        <KPICard label="缺数据" value={(stats as any)?.byStatus?.NEEDS_RAW ?? 0} tone="err" icon="✗" />
        <KPICard label="已提取" value={(stats as any)?.byStatus?.PROCESSED ?? 0} tone="ok" icon="✓" />
      </div>

      {/* Agent 管道卡片 (4 卡片, 按 agent 维度) — 业务目标: 每个 agent 独立 */}
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space>
            <TeamOutlined style={{ color: C.brandMind }} />
            <span>Agent 会话</span>
            <Tag color="cyan">{agents.length} active</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>
              (业务目标: 4 个接入 agent 独立管道管理)
            </Text>
          </Space>
        }
        extra={
          <Space>
            <span style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>最大处理:</span>
            <InputNumber min={1} max={20} value={maxConvs} onChange={(v) => v && setMaxConvs(v)} style={{ width: 70 }} />
            {/* B19 修复 (2026-06-18 15:30): 一键处理全部 4 agent 管道 */}
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={running === "ALL"}
              onClick={handleRunAllAgents}
              style={{ background: "var(--brand-flow)", borderColor: "var(--brand-flow)" }}
            >
              一键处理全部 ({agents.length} agents)
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => { fetchStats(); fetchHistory(); fetchAgents(); }}>刷新</Button>
          </Space>
        }
      >
        {agents.length === 0 ? (
          <Empty description="暂无 agent 接入" />
        ) : (
          <Row gutter={[16, 16]}>
            {agents.map((a) => {
              const channelColor: Record<string, string> = {
                mcp: C.brandMind, custom: C.brandFlow, hermes: C.brandAxon,
              };
              const chColor = (a.channel && channelColor[a.channel]) || C.brandSynapse;
              const isActive = ((a as any).pending ?? 0) > 0 || ((a as any).processed ?? 0) > 0;
              return (
                <Col key={a.agent_id} xs={24} md={12} lg={8} xl={6}>
                  <Card
                    size="small"
                    style={{
                      background: C.bgElevated,
                      borderColor: C.borderHi,
                      borderLeft: `3px solid ${chColor}`,
                      height: "100%",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: C.inkPrimary }}>
                          {a.display_name || a.agent_id}
                        </div>
                        <div style={{ fontSize: 11, color: C.inkTertiary, fontFamily: "var(--font-mono)" }}>
                          {a.agent_id} · {a.channel}
                        </div>
                      </div>
                      <Tag color={isActive ? "green" : "default"} style={{ marginRight: 0 }}>
                        {isActive ? "ACTIVE" : "IDLE"}
                      </Tag>
                    </div>
                    {/* Session 状态分布 (每个 agent 独立) */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 10, color: C.inkDim }}>总数</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.brandMind }}>{(a as any).total_sessions ?? 0}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: C.inkDim }}>待提取</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.brandSynapse }}>{(a as any).pending ?? 0}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: C.inkDim }}>已提取</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--status-ok)" }}>{(a as any).processed ?? 0}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: C.inkDim }}>失败</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--status-err)" }}>{(a as any).failed ?? 0}</div>
                      </div>
                    </div>

                    {/* 时间线 */}
                    <div style={{ fontSize: 10, color: C.inkDim, marginBottom: 8 }}>
                      <div>最近活动: {(a as any).last_activity ? new Date((a as any).last_activity).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }).slice(0, 16) : "-"}</div>
                      <div>数据量: {(a as any).total_size_kb ?? 0} KB</div>
                    </div>
                    {/* 触发按钮 (每个 agent 独立) */}
                    <Button
                      type="primary"
                      size="small"
                      icon={<ThunderboltOutlined />}
                      loading={running === a.agent_id}
                      onClick={() => handleRunAgent(a.agent_id)}
                      block
                      style={{ background: C.brandMind, borderColor: C.brandMind }}
                    >
                      提取 {a.agent_id} 会话
                    </Button>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </Card>

      {/* Global Organizer — 飞轮全局整理 */}
      <Card
        size="small"
        style={{ marginBottom: 16, borderColor: "var(--brand-flow)" }}
        title={
          <Space>
            <ApiOutlined style={{ color: "var(--brand-flow)" }} />
            <span>全局整理 (Global Organizer)</span>
            <Tag color="purple">飞轮 ④a+④b</Tag>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Space>
            <input
              placeholder="输入 groupKey..."
              value={goGroupKey}
              onChange={(e) => setGoGroupKey(e.target.value)}
              style={{
                width: 360, padding: "4px 12px", fontSize: 13,
                border: "1px solid var(--border-hi)", borderRadius: 6,
                background: "var(--bg-elevated)", color: "var(--ink-primary)",
              }}
              onKeyDown={(e) => e.key === "Enter" && handleGoRun()}
            />
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={goPolling}
              onClick={handleGoRun}
              style={{ background: "var(--brand-flow)", borderColor: "var(--brand-flow)" }}
            >
              运行
            </Button>
            <Button
              icon={<SyncOutlined />}
              onClick={handleGoRunAll}
              disabled={goPolling}
            >
              一键处理 PENDING (≤3)
            </Button>
          </Space>

          {goStatus && goStatus.error && (
            <div style={{ padding: 8, borderRadius: 6, background: "rgba(255,77,79,0.08)", fontSize: 12, color: "var(--status-err)" }}>
              错误: {goStatus.error}
            </div>
          )}
        </Space>
      </Card>

      {/* P2: 飞轮可视化 - 7步流水线 + 健康指标 + 事件流 */}
      <FlywheelDashboard goStatus={goStatus} goPolling={goPolling} />

      {/* 运行结果 Table — B13 修复后能用 */}
      <Card
        size="small"
        title={
          <Space>
            <DatabaseOutlined />
            <span>会话列表 (最近 200 条)</span>
            <Tag color="green">{history.length} 条</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>
              (B13 修复: setHistory 正确 + take:200 跟 stats count 一致)
            </Text>
          </Space>
        }
      >
        {history.length > 0 ? (
          <Table
            dataSource={history}
            columns={historyColumns}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 10 }}
          />
        ) : (
          <Empty description="暂无会话记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      {/* 已删除模块 (业务结构归位) */}
      <Card size="small" style={{ marginTop: 16, background: "var(--surface-hi)" }}>
        <div style={{ fontSize: 12, color: "var(--ink-tertiary)" }}>
          ℹ️ 已删除 (按 6/18 重构方案):
          <ul style={{ marginTop: 4, marginBottom: 0, paddingLeft: 20 }}>
            <li>轮转状态控制 (start/stop/cron) → <a href="/rotation">/rotation</a> 新页面</li>
            <li>3 Tab (运行结果/轮转历史/认知分布) → 改 Table 集成 (运行结果) + 删除重复</li>
            <li>手动管道 (Claude scan/run + Hermes scan/run) → 改按 agent 触发 (上方 4 卡片)</li>
            <li>Agent 本地 session → 同步到 lions-session → 本页触发提取 → Memory/Knowledge/Reflection/Practice</li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
