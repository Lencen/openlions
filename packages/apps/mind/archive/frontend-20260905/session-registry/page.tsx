"use client";

/**
 * Session Registry 独立管理页面 (SHARED-BRAIN V3 P5 重构)
 * 2026-06-18 按 agent 维度重组
 *
 * 首页 (默认路径): 卡片展示全部已接入 agent (AgentRegistry)
 *   - 卡片: agent 名称 + 图标 + channel + 状态 + session 统计 + 待提取数量
 *   - 顶部: KPI 统计 + 趋势图 (最近 30 天 upload/processed/failed)
 *   - 卡片点击 → agent 详情页 (嵌套路由)
 *
 * 详情页: 单个 agent 的所有 session 列表
 *   - 完整字段: 会话状态 / 名称 / 创建时间 / 最后更新 / 总大小 / 待提取数量 / 待提取大小 / 提取状态 / 备注
 *   - FAILED 可点「重试」(重置 PENDING)
 */

import { useState, useEffect, useCallback } from "react";
import { useThemeColors } from "@/hooks/useThemeColors";
import {
  Card, Button, Row, Col, Typography, Tag, Space,
  Statistic, Table, message, Alert,
  Progress, Tooltip, Empty, Breadcrumb, Popconfirm, Spin,
  // B18/B21 修复 (2026-06-18 15:36): 详情页加 Select 排序 + Switch 活动过滤
  Select, Switch,
} from "antd";
import {
  DatabaseOutlined, PlayCircleOutlined, ReloadOutlined,
  CloudUploadOutlined, ApiOutlined, CheckCircleOutlined,
  ClockCircleOutlined, CloseCircleOutlined, UserOutlined,
  ArrowLeftOutlined, SyncOutlined, WarningOutlined,
  ThunderboltOutlined, BarChartOutlined,
} from "@ant-design/icons";
import ReactECharts from "echarts-for-react";

const { Title, Text } = Typography;

interface AgentCard {
  agent_id: string;
  display_name: string;
  channel: string;
  host: string;
  avatar: string | null;
  agent_status: string; // ACTIVE / INACTIVE
  last_seen_at: string | null;
  created_at: string;
  total_sessions: number;
  pending: number;
  processing: number;
  processed: number;
  failed: number;
  skipped: number;
  total_size_kb: number;
  pending_size_kb: number;
  last_activity: string | null;
}

interface SessionItem {
  id: string;
  session_uid: string;
  agent_id: string;
  source: string;
  source_id: string;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_message_at: string | null;
  message_count: number;
  status: string;
  processed_at: string | null;
  processing_error: string | null;
  fingerprint: string;
  payload_size: number;
  uploaded_at: string;
  updated_at: string;
}

interface TrendPoint {
  day: string;
  uploaded: number;
  processed: number;
  failed: number;
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: "orange",
  PROCESSING: "blue",
  PROCESSED: "green",
  FAILED: "red",
  SKIPPED: "default",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "待提取",
  PROCESSING: "提取中",
  PROCESSED: "已完成",
  FAILED: "失败",
  SKIPPED: "跳过",
};

// 会话状态 (业务状态, 非提取状态)
const SESSION_STATUS_MAP: Record<string, string> = {
  active: "活跃",
  idle: "静默",
  closed: "已关闭",
};

const CHANNEL_LABEL: Record<string, string> = {
  hermes: "Hermes",
  claude: "Claude",
  mcp: "MCP",
  custom: "自定义",
};

export default function SessionRegistryPage() {
  const C = useThemeColors();
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  // 详情页状态
  const [selectedAgent, setSelectedAgent] = useState<AgentCard | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // B18/B21 修复 (2026-06-18 15:35): 详情页排序 + 活动过滤 state
  const [sessionSortBy, setSessionSortBy] = useState("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [activeOnly, setActiveOnly] = useState(false);

  // 趋势图
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [trendDays, setTrendDays] = useState(30);

  // 全局统计
  const [total, setTotal] = useState(0);
  const [totalPending, setTotalPending] = useState(0);
  const [totalFailed, setTotalFailed] = useState(0);
  const [totalSize, setTotalSize] = useState(0);

  // 处理 pipeline
  const [processing, setProcessing] = useState(false);

  // 拉 agent 列表 (首页)
  const fetchAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const res = await fetch("/api/trpc/sessionRegistry.byAgent");
      const json = await res.json();
      if (json?.result?.data) {
        setAgents(json.result.data.agents || []);
        // 汇总 KPI
        const a = json.result.data.agents || [];
        setTotal(a.reduce((s: number, c: AgentCard) => s + c.total_sessions, 0));
        setTotalPending(a.reduce((s: number, c: AgentCard) => s + c.pending, 0));
        setTotalFailed(a.reduce((s: number, c: AgentCard) => s + c.failed, 0));
        setTotalSize(a.reduce((s: number, c: AgentCard) => s + c.total_size_kb, 0));
      }
    } catch (e) {
      console.error("fetchAgents failed:", e);
      message.error("获取 agent 列表失败");
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  // 拉趋势图
  const fetchTrends = useCallback(async (days = 30) => {
    try {
      const params = `?input=${encodeURIComponent(JSON.stringify({ json: { days } }))}`;
      const res = await fetch(`/api/trpc/sessionRegistry.trends${params}`);
      const json = await res.json();
      if (json?.result?.data) {
        setTrends(json.result.data.trends || []);
        setTrendDays(json.result.data.days || 30);
      }
    } catch (e) {
      console.error("fetchTrends failed:", e);
    }
  }, []);

  // 拉单个 agent 的 session 列表 (详情页)
  const fetchAgentSessions = useCallback(async (agentId: string, opts?: { activeOnly?: boolean; sortBy?: string; sortOrder?: string }) => {
    setSessionsLoading(true);
    try {
      const input = {
        limit: 200,
        agent_id: agentId,
        // B21: 活动 session 过滤
        activeOnly: opts?.activeOnly,
        // B18: 排序
        sortBy: opts?.sortBy,
        sortOrder: opts?.sortOrder,
      };
      const params = `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
      const res = await fetch(`/api/trpc/sessionRegistry.list${params}`);
      const json = await res.json();
      if (json?.result?.data) {
        setSessions(json.result.data.items || []);
      }
    } catch (e) {
      console.error("fetchAgentSessions failed:", e);
      message.error("获取 session 列表失败");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  // 批量重试 FAILED (按 agent)
  const handleRetryFailed = useCallback(async (agentId: string) => {
    try {
      const res = await fetch("/api/trpc/sessionRegistry.retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { agent_id: agentId } }),
      });
      const json = await res.json();
      if (json?.result?.data) {
        message.success(`已将 ${json.result.data.updated} 个 FAILED session 重置为 PENDING`);
        await fetchAgents();
        if (selectedAgent) await fetchAgentSessions(selectedAgent.agent_id);
      } else if (json?.error) {
        message.error(`重试失败: ${json.error.message}`);
      }
    } catch (e) {
      message.error(`请求异常: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [fetchAgents, selectedAgent, fetchAgentSessions]);

  // 触发 pipeline
  const handleProcess = useCallback(async (agentId: string, limit: number, dryRun: boolean) => {
    setProcessing(true);
    try {
      const res = await fetch("/api/trpc/sessionRegistry.processPipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { limit, dryRun, agent_id: agentId } }),
      });
      const json = await res.json();
      if (json?.result?.data) {
        const { claimed, processed, failed, skipped } = json.result.data;
        const success = failed === 0 ? "success" : "warning";
        message[success](`处理完成: claimed=${claimed}, processed=${processed}, failed=${failed}, skipped=${skipped}`);
        await fetchAgents();
        if (selectedAgent) await fetchAgentSessions(selectedAgent.agent_id);
      } else if (json?.error) {
        message.error(`处理失败: ${json.error.message}`);
      }
    } catch (e) {
      message.error(`请求异常: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProcessing(false);
    }
  }, [fetchAgents, selectedAgent, fetchAgentSessions]);

  // 初始化
  useEffect(() => {
    fetchAgents();
    fetchTrends(30);
  }, [fetchAgents, fetchTrends]);

  // 选中 agent
  const handleAgentClick = (agent: AgentCard) => {
    setSelectedAgent(agent);
    fetchAgentSessions(agent.agent_id);
  };

  // 返回首页
  const handleBack = () => {
    setSelectedAgent(null);
    setSessions([]);
  };

  // --- 首页渲染: agent 卡片 + 趋势图 ---
  if (!selectedAgent) {
    return (
      <div style={{ padding: 24, background: C.bgBase, minHeight: "100vh" }}>
        <Title level={3} style={{ color: C.inkPrimary, marginBottom: 20 }}>
          <DatabaseOutlined style={{ color: C.brandMind, marginRight: 8 }} />
          Session Registry 中枢服务
        </Title>

        <Alert
          message="按 Agent 维度管理 Session 数据"
          description="全部已接入 Agent 从 AgentRegistry 拉取，不只是有 session 的 Agent。每个 Agent 的历史 session 可全量同步，Pipeline 从 SessionRegistry 提取认知数据。"
          type="info"
          showIcon
          style={{ marginBottom: 16, background: C.surface, border: `1px solid ${C.border}` }}
        />

        {/* 全局 KPI */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              <Statistic
                title={<span style={{ color: C.inkSecondary }}>总 Session</span>}
                value={total}
                prefix={<DatabaseOutlined style={{ color: C.brandMind }} />}
                valueStyle={{ color: C.inkPrimary }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              <Statistic
                title={<span style={{ color: C.inkSecondary }}>待提取</span>}
                value={totalPending}
                prefix={<ClockCircleOutlined style={{ color: C.statusWarn }} />}
                valueStyle={{ color: C.statusWarn }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              <Statistic
                title={<span style={{ color: C.inkSecondary }}>失败</span>}
                value={totalFailed}
                prefix={<CloseCircleOutlined style={{ color: C.statusErr }} />}
                valueStyle={{ color: C.statusErr }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              <Statistic
                title={<span style={{ color: C.inkSecondary }}>总大小</span>}
                value={totalSize.toFixed(1)}
                suffix="KB"
                prefix={<ApiOutlined style={{ color: C.brandFlow }} />}
                valueStyle={{ color: C.inkPrimary }}
              />
            </Card>
          </Col>
        </Row>

        {/* 趋势图 */}
        <Card
          title={<span style={{ color: C.inkPrimary }}><BarChartOutlined /> 最近 {trendDays} 天趋势</span>}
          size="small"
          extra={
            <Button icon={<ReloadOutlined />} onClick={() => fetchTrends(30)} size="small">
              刷新
            </Button>
          }
          style={{ marginBottom: 16, background: C.surface, border: `1px solid ${C.border}` }}
        >
          {trends.length > 0 ? (
            <ReactECharts
              option={{
                tooltip: { trigger: "axis" },
                legend: { data: ["新上传", "已处理", "失败"], textStyle: { color: C.inkSecondary }, top: 0 },
                grid: { left: 40, right: 20, top: 30, bottom: 30 },
                xAxis: {
                  type: "category",
                  data: trends.map(t => t.day.substring(5)),
                  axisLabel: { color: C.inkTertiary, fontSize: 10 },
                  axisLine: { lineStyle: { color: C.border } },
                },
                yAxis: {
                  type: "value",
                  axisLabel: { color: C.inkTertiary, fontSize: 10 },
                  axisLine: { lineStyle: { color: C.border } },
                  splitLine: { lineStyle: { color: C.borderSoft } },
                },
                series: [
                  { name: "新上传", type: "line", data: trends.map(t => t.uploaded), smooth: true, itemStyle: { color: C.brandMind } },
                  { name: "已处理", type: "line", data: trends.map(t => t.processed), smooth: true, itemStyle: { color: C.statusOk } },
                  { name: "失败", type: "line", data: trends.map(t => t.failed), smooth: true, itemStyle: { color: C.statusErr } },
                ],
              }}
              style={{ height: 200 }}
              opts={{ renderer: "svg" }}
            />
          ) : (
            <Empty description="暂无趋势数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>

        {/* Agent 卡片列表 */}
        <Card
          title={<span style={{ color: C.inkPrimary }}><UserOutlined /> 已接入 Agent ({agents.length})</span>}
          size="small"
          extra={
            <Button icon={<ReloadOutlined />} onClick={fetchAgents} loading={agentsLoading} size="small">
              刷新
            </Button>
          }
          style={{ background: C.surface, border: `1px solid ${C.border}` }}
        >
          <Row gutter={16}>
            {agents.map((agent) => (
              <Col key={agent.agent_id} xs={24} sm={12} md={8} lg={6} style={{ marginBottom: 16 }}>
                <Card
                  size="small"
                  hoverable
                  onClick={() => handleAgentClick(agent)}
                  style={{
                    background: agent.agent_status === "ACTIVE" ? C.surfaceHi : C.surface,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    height: "100%",
                  }}
                  bodyStyle={{ padding: 12 }}
                >
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: C.brandMind,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "white",
                        fontWeight: "bold",
                        marginRight: 10,
                      }}
                    >
                      {agent.display_name.substring(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: C.inkPrimary, fontWeight: 500, fontSize: 14 }}>
                        {agent.display_name}
                      </div>
                      <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                        <Tag color="geekblue" style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>
                          {CHANNEL_LABEL[agent.channel] || agent.channel}
                        </Tag>
                        <Tag color={agent.agent_status === "ACTIVE" ? "green" : "default"} style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>
                          {agent.agent_status}
                        </Tag>
                      </div>
                    </div>
                  </div>

                  {/* 状态分布进度条 */}
                  <div style={{ marginBottom: 8 }}>
                    <Progress
                      percent={agent.total_sessions > 0 ? Math.round((agent.pending / agent.total_sessions) * 100) : 0}
                      showInfo={false}
                      strokeWidth={6}
                      strokeColor={C.statusWarn}
                      style={{ marginBottom: 2 }}
                    />
                    <Space size={[10, 0]} wrap style={{ fontSize: 11, color: C.inkTertiary }}>
                      <span><Tag color="orange" style={{ fontSize: 10, padding: "0 3px" }}>待</Tag> {agent.pending}</span>
                      <span><Tag color="green" style={{ fontSize: 10, padding: "0 3px" }}>成</Tag> {agent.processed}</span>
                      <span><Tag color="red" style={{ fontSize: 10, padding: "0 3px" }}>败</Tag> {agent.failed}</span>
                      <span><Tag color="default" style={{ fontSize: 10, padding: "0 3px" }}>总</Tag> {agent.total_sessions}</span>
                    </Space>
                  </div>

                  {/* 大小信息 */}
                  <div style={{ fontSize: 11, color: C.inkTertiary }}>
                    总 {agent.total_size_kb.toFixed(1)} KB · 待提取 {agent.pending_size_kb.toFixed(1)} KB
                  </div>

                  {/* FAILED 提示 */}
                  {agent.failed > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.borderSoft}` }}>
                      <Popconfirm
                        title={`确定要把 ${agent.failed} 个失败 session 重置为待提取吗？`}
                        onConfirm={(e) => { e?.stopPropagation(); handleRetryFailed(agent.agent_id); }}
                        okText="确定重置"
                        cancelText="取消"
                      >
                        <Button
                          type="text"
                          danger
                          size="small"
                          icon={<WarningOutlined />}
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontSize: 11, padding: "0 4px", height: "auto" }}
                        >
                          {agent.failed} 个失败 - 点击重试
                        </Button>
                      </Popconfirm>
                    </div>
                  )}
                </Card>
              </Col>
            ))}
          </Row>

          {agents.length === 0 && !agentsLoading && (
            <Empty description="暂无已接入 Agent" />
          )}
        </Card>
      </div>
    );
  }

  // --- 详情页渲染: 单个 agent 的 session 列表 ---
  return (
    <div style={{ padding: 24, background: C.bgBase, minHeight: "100vh" }}>
      <Breadcrumb style={{ marginBottom: 16, color: C.inkSecondary }}>
        <Breadcrumb.Item>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={handleBack} style={{ padding: 0 }}>
            返回 Agent 列表
          </Button>
        </Breadcrumb.Item>
        <Breadcrumb.Item>{selectedAgent.display_name} 的 Session</Breadcrumb.Item>
      </Breadcrumb>

      <Card
        size="small"
        style={{ marginBottom: 16, background: C.surface, border: `1px solid ${C.border}` }}
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: C.brandMind,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontWeight: "bold",
                fontSize: 12,
              }}
            >
              {selectedAgent.display_name.substring(0, 2).toUpperCase()}
            </div>
            <span style={{ color: C.inkPrimary }}>
              {selectedAgent.display_name} ({selectedAgent.agent_id})
            </span>
            <Tag color={selectedAgent.agent_status === "ACTIVE" ? "green" : "default"}>
              {selectedAgent.agent_status}
            </Tag>
          </div>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => fetchAgentSessions(selectedAgent.agent_id)} loading={sessionsLoading} size="small">
              刷新列表
            </Button>
            {selectedAgent.pending > 0 && (
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={() => handleProcess(selectedAgent.agent_id, 10, false)}
                loading={processing}
                size="small"
              >
                提取 10 个
              </Button>
            )}
            {selectedAgent.failed > 0 && (
              <Popconfirm
                title={`确定要把 ${selectedAgent.failed} 个失败 session 重置为待提取吗？`}
                onConfirm={() => handleRetryFailed(selectedAgent.agent_id)}
                okText="确定重置"
                cancelText="取消"
              >
                <Button danger icon={<WarningOutlined />} size="small">
                  重试失败 ({selectedAgent.failed})
                </Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        <Row gutter={16}>
          <Col span={4}>
            <Statistic
              title="总 Session"
              value={selectedAgent.total_sessions}
              valueStyle={{ color: C.inkPrimary, fontSize: 18 }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="待提取"
              value={selectedAgent.pending}
              valueStyle={{ color: C.statusWarn, fontSize: 18 }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="已完成"
              value={selectedAgent.processed}
              valueStyle={{ color: C.statusOk, fontSize: 18 }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="失败"
              value={selectedAgent.failed}
              valueStyle={{ color: C.statusErr, fontSize: 18 }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="总大小"
              value={`${selectedAgent.total_size_kb.toFixed(1)} KB`}
              valueStyle={{ color: C.inkPrimary, fontSize: 18 }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="待提取大小"
              value={`${selectedAgent.pending_size_kb.toFixed(1)} KB`}
              valueStyle={{ color: C.statusWarn, fontSize: 18 }}
            />
          </Col>
        </Row>
      </Card>

      <Card
        title={`Session 列表 (${sessions.length})`}
        size="small"
        style={{ background: C.surface, border: `1px solid ${C.border}` }}
        // B18/B21 修复 (2026-06-18 15:35): 详情页加排序 + 活动过滤控件
        extra={
          <Space>
            <span style={{ fontSize: 12, color: C.inkTertiary }}>排序:</span>
            <Select
              size="small"
              style={{ width: 130 }}
              value={sessionSortBy}
              onChange={(v) => {
                setSessionSortBy(v);
                if (selectedAgent) fetchAgentSessions(selectedAgent.agent_id, { activeOnly, sortBy: v, sortOrder });
              }}
              options={[
                { value: "updated_at", label: "最近更新" },
                { value: "last_message_at", label: "最后消息" },
                { value: "uploaded_at", label: "上传时间" },
                { value: "started_at", label: "创建时间" },
                { value: "message_count", label: "消息数" },
              ]}
            />
            <Select
              size="small"
              style={{ width: 80 }}
              value={sortOrder}
              onChange={(v) => {
                setSortOrder(v);
                if (selectedAgent) fetchAgentSessions(selectedAgent.agent_id, { activeOnly, sortBy: sessionSortBy, sortOrder: v });
              }}
              options={[
                { value: "desc", label: "↓ 降序" },
                { value: "asc", label: "↑ 升序" },
              ]}
            />
            <Switch
              size="small"
              checkedChildren="🔴 仅活动"
              unCheckedChildren="全部"
              checked={activeOnly}
              onChange={(v) => {
                setActiveOnly(v);
                if (selectedAgent) fetchAgentSessions(selectedAgent.agent_id, { activeOnly: v, sortBy: sessionSortBy, sortOrder });
              }}
            />
          </Space>
        }
      >
        {sessionsLoading ? (
          <div style={{ textAlign: "center", padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (
          <Table
            dataSource={sessions}
            rowKey="id"
            size="small"
            scroll={{ x: 1400 }}
            pagination={{ pageSize: 30 }}
            columns={[
              {
                title: "提取状态", dataIndex: "status", key: "status", width: 90,
                render: (s: string) => (
                  <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s] || s}</Tag>
                ),
              },
              {
                title: "会话状态", dataIndex: "last_message_at", key: "session_status", width: 80,
                render: (lastMsg: string | null) => {
                  // 简易规则: last_message_at 7 天内 = 活跃, 30 天内 = 静默, 其余 = 已关闭
                  if (!lastMsg) return <Tag color="default">关闭</Tag>;
                  const days = (Date.now() - new Date(lastMsg).getTime()) / (1000 * 60 * 60 * 24);
                  if (days < 7) return <Tag color="green">活跃</Tag>;
                  if (days < 30) return <Tag color="orange">静默</Tag>;
                  return <Tag color="default">关闭</Tag>;
                },
              },
              { title: "Source", dataIndex: "source", key: "source", width: 110,
                render: (s: string) => <Tag>{s.replace("_CONVERSATION", "").replace("_SESSION", "")}</Tag> },
              {
                title: "会话名称", dataIndex: "title", key: "title", ellipsis: true, width: 200,
                render: (t: string | null) => t || <Text style={{ color: C.inkTertiary }}>(无标题)</Text>,
              },
              {
                title: "创建时间", dataIndex: "started_at", key: "started_at", width: 150,
                render: (s: string | null) => s ? new Date(s).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }).substring(0, 16) : "-",
              },
              {
                title: "最后更新", dataIndex: "last_message_at", key: "last_message_at", width: 150,
                render: (s: string | null) => s ? new Date(s).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }).substring(0, 16) : "-",
              },
              { title: "消息数", dataIndex: "message_count", key: "message_count", width: 60 },
              {
                title: "总大小", dataIndex: "payload_size", key: "payload_size", width: 70,
                render: (s: number) => `${(s / 1024).toFixed(1)}KB`,
              },
              {
                title: "备注", dataIndex: "processing_error", key: "processing_error", width: 180,
                render: (e: string | null) => e ? (
                  <Tooltip title={e}>
                    <Text style={{ color: C.statusErr, fontSize: 11 }} ellipsis>
                      {e.substring(0, 30)}...
                    </Text>
                  </Tooltip>
                ) : <Text style={{ color: C.inkTertiary }}>-</Text>,
              },
              {
                title: "操作", key: "action", width: 80,
                render: (_, r) => r.status === "FAILED" ? (
                  <Popconfirm
                    title="确定要重置为待提取吗？"
                    onConfirm={async () => {
                      try {
                        const res = await fetch("/api/trpc/sessionRegistry.retry", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ json: { session_uid: r.session_uid } }),
                        });
                        const json = await res.json();
                        if (json?.result?.data) {
                          message.success("已重置");
                          await fetchAgentSessions(selectedAgent.agent_id);
                        }
                      } catch (e) { message.error("失败"); }
                    }}
                    okText="确定"
                    cancelText="取消"
                  >
                    <Button type="text" danger size="small" style={{ padding: 0 }}>
                      重试
                    </Button>
                  </Popconfirm>
                ) : null,
              },
            ]}
          />
        )}
        {sessions.length === 0 && !sessionsLoading && (
          <Empty description="暂无 Session 数据" />
        )}
      </Card>
    </div>
  );
}
