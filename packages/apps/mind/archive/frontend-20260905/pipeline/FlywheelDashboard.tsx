"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Tag, Spin, Empty, Tooltip, Button, Space, Popconfirm } from "antd";
import {
  ApiOutlined, SyncOutlined, CheckCircleOutlined,
  DatabaseOutlined, AimOutlined, ClockCircleOutlined,
  ThunderboltOutlined, InboxOutlined, LinkOutlined,
  ClearOutlined,
} from "@ant-design/icons";

// ─── Types ──────────────────────────────────────────────────

interface GoTaskStatus {
  taskId: string;
  groupKey: string;
  status: string; // STARTED | RUNNING | DONE | FAILED
  duration?: number;
  products?: { memory: number; knowledge: number; practice: number; reflection: number };
  calibration?: { super: number; stale: number; create: number; merge: number };
  skills?: number;
  stalePropagated?: number;
  error?: string;
}

interface FlywheelEventItem {
  id: string;
  stage: string;
  sourceType: string;
  sourceTitle: string;
  targetStage: string;
  targetType: string | null;
  createdAt: string;
}

// 2026-07-12 PHASE-B 版本联动
interface StaleRecord {
  id: string;
  theme: string | null;
  staleReason: string | null;
}
interface StaleSummary {
  knowledge: StaleRecord[];
  skill: StaleRecord[];
  practice: StaleRecord[];
  counts: { knowledge: number; skill: number; practice: number };
}

// ─── 7 Steps Definition ────────────────────────────────────

const PIPELINE_STEPS = [
  { key: "load", label: "加载消息", icon: InboxOutlined, desc: "从 SessionGroup 拉取全部原始对话" },
  { key: "chunk", label: "智能分块", icon: DatabaseOutlined, desc: "按 token 估算分批 (≤12K tokens/chunk)" },
  { key: "llm", label: "LLM 合成", icon: ThunderboltOutlined, desc: "每批一次 LLM 调用, 产出记忆/知识/实践/反思" },
  { key: "write", label: "写入 DB", icon: DatabaseOutlined, desc: "4 表入库 + contentHash 去重 + FlywheelEvent" },
  { key: "calibrate", label: "记忆校准", icon: AimOutlined, desc: "全局记忆 vs 碎片: SUPER/STALE/CREATE/MERGE" },
  { key: "stale", label: "标记过期", icon: ClockCircleOutlined, desc: "旧 GLOBAL_ORGANIZER 产物标记 STALE" },
  { key: "skill", label: "技能合成", icon: ApiOutlined, desc: "同 theme Knowledge≥3 -> LLM 打包 -> Skill upsert" },
];

const stageLabel: Record<string, string> = {
  LEARN: "学习", REFLECT: "反思", MEMORIZE: "记忆", KNOWLEDGE: "知识",
  PRACTICE: "实践", OUTCOME: "产出", EVALUATE: "评估",
  GLOBAL_ORGANIZER: "全局整理", REFLECTION_TO_TASK: "反思→任务", TASK_TO_FILL: "任务→回填",
};

const stageColor: Record<string, string> = {
  LEARN: "#52c41a", REFLECT: "#eb2f96", MEMORIZE: "#667eea",
  KNOWLEDGE: "#1890ff", PRACTICE: "#faad14", OUTCOME: "#13c2c2",
  EVALUATE: "#722ed1", GLOBAL_ORGANIZER: "#fa541c",
  REFLECTION_TO_TASK: "#ff4d4f", TASK_TO_FILL: "#ff7a45",
};

// ─── Component ──────────────────────────────────────────────

export function FlywheelDashboard({ goStatus, goPolling }: {
  goStatus: GoTaskStatus | null;
  goPolling: boolean;
}) {
  const [events, setEvents] = useState<FlywheelEventItem[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // 2026-07-12 PHASE-B: stale records + clear 操作状态
  const [stale, setStale] = useState<StaleSummary | null>(null);
  const [clearingId, setClearingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [evRes, hlRes, staleRes] = await Promise.all([
        fetch("/api/trpc/stats.getActivityFeed?input=" + encodeURIComponent(JSON.stringify({ limit: 15 }))).then(r => r.json()),
        fetch("/api/trpc/stats.getFlywheelHealth").then(r => r.json()),
        fetch("/api/trpc/flywheel.getStaleRecords?input=" + encodeURIComponent(JSON.stringify({ limit: 50 }))).then(r => r.json()),
      ]);
      setEvents(evRes.result?.data ?? []);
      setHealth(hlRes.result?.data ?? null);
      setStale(staleRes.result?.data ?? null);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  // 手动清某条 stale 记录
  const handleClearStale = useCallback(async (targetType: "knowledge" | "skill" | "practice", targetId: string) => {
    setClearingId(targetId);
    try {
      await fetch("/api/trpc/flywheel.clearStaleFlag?input=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { targetType, targetId } }),
      });
      await fetchData();
    } finally {
      setClearingId(null);
    }
  }, [fetchData]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, goPolling ? 3000 : 30000);
    return () => clearInterval(interval);
  }, [fetchData, goPolling]);

  // Determine step statuses based on goStatus
  const getStepStatus = (stepIdx: number): "done" | "running" | "pending" | "failed" => {
    if (!goStatus) return "pending";
    if (goStatus.status === "FAILED") {
      // Determine how far it got from products/calibration presence
      if (stepIdx <= 3 && goStatus.products) return "done";
      return "failed";
    }
    if (goStatus.status === "DONE") return "done";
    if (goStatus.status === "RUNNING" || goStatus.status === "STARTED") {
      // Estimate current step from duration
      const dur = goStatus.duration ?? 0;
      if (dur < 5) return stepIdx === 0 ? "running" : "pending";
      if (dur < 15) return stepIdx <= 1 ? "done" : stepIdx === 2 ? "running" : "pending";
      if (dur < 30) return stepIdx <= 2 ? "done" : stepIdx === 3 ? "running" : "pending";
      if (dur < 45) return stepIdx <= 3 ? "done" : stepIdx === 4 ? "running" : "pending";
      if (dur < 60) return stepIdx <= 4 ? "done" : stepIdx === 5 ? "running" : "pending";
      return stepIdx <= 5 ? "done" : stepIdx === 6 ? "running" : "pending";
    }
    return "pending";
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
    if (diffSec < 60) return `${diffSec}秒前`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ─── Pipeline 7-step visualization ─── */}
      <Card
        size="small"
        title={<span><ApiOutlined style={{ marginRight: 8 }} />飞轮管线 · 7 步流水线</span>}
        style={goStatus?.status === "RUNNING" || goStatus?.status === "STARTED" ? {
          animation: "pulse 2s infinite",
        } : undefined}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 }}>
          {PIPELINE_STEPS.map((step, idx) => {
            const status = getStepStatus(idx);
            const Icon = step.icon;
            const colors = {
              done: { bg: "var(--status-ok-bg)", color: "var(--status-ok)", border: "var(--status-ok)" },
              running: { bg: "var(--accent-bg)", color: "var(--accent-primary)", border: "var(--accent-primary)" },
              pending: { bg: "var(--surface-hi)", color: "var(--ink-tertiary)", border: "var(--border-soft)" },
              failed: { bg: "var(--status-err-bg)", color: "var(--status-err)", border: "var(--status-err)" },
            }[status];
            return (
              <div key={step.key} style={{
                padding: "10px 8px", borderRadius: 8,
                background: colors.bg, border: `1px solid ${colors.border}`,
                textAlign: "center", position: "relative",
              }}>
                <div style={{ fontSize: 20, color: colors.color, marginBottom: 4 }}>
                  <Icon />
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: colors.color }}>{step.label}</div>
                <div style={{ fontSize: 10, color: "var(--ink-tertiary)", marginTop: 4, lineHeight: 1.3 }}>
                  {step.desc}
                </div>
                {status === "running" && (
                  <div style={{ position: "absolute", top: 4, right: 4 }}>
                    <SyncOutlined spin style={{ fontSize: 10, color: colors.color }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {goStatus && (
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--ink-secondary)", display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div>任务 ID: <code style={{ fontSize: 11 }}>{goStatus.groupKey}</code></div>
            <div>状态: <Tag color={
              goStatus.status === "DONE" ? "success" :
              goStatus.status === "FAILED" ? "error" :
              goStatus.status === "RUNNING" || goStatus.status === "STARTED" ? "processing" : "default"
            }>{goStatus.status}</Tag></div>
            {goStatus.duration && <div>耗时: <strong>{goStatus.duration.toFixed(1)}s</strong></div>}
            {goStatus.products && (
              <div>产物: M={goStatus.products.memory} · K={goStatus.products.knowledge} · P={goStatus.products.practice} · R={goStatus.products.reflection}</div>
            )}
            {goStatus.calibration && (
              <div>校准: SUPER={goStatus.calibration.super} · STALE={goStatus.calibration.stale} · CREATE={goStatus.calibration.create} · MERGE={goStatus.calibration.merge}</div>
            )}
            {goStatus.stalePropagated != null && goStatus.stalePropagated > 0 && (
              <div>过期标记: <strong>{goStatus.stalePropagated}</strong></div>
            )}
            {goStatus.skills != null && goStatus.skills > 0 && (
              <div><Tag color="gold">技能合成 {goStatus.skills}</Tag></div>
            )}
            {goStatus.error && <div style={{ color: "var(--status-err)" }}>错误: {goStatus.error}</div>}
          </div>
        )}

        {/* Pulse animation CSS */}
        <style>{`
          @keyframes pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(24,144,255,0.3); }
            50% { box-shadow: 0 0 0 6px rgba(24,144,255,0); }
          }
        `}</style>
      </Card>

      {/* ─── Health Dashboard + Event Stream ─── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Health metrics */}
        <Card size="small" title={<span><DatabaseOutlined style={{ marginRight: 8 }} />认知产物总览</span>}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>
          ) : health ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {health.stages?.map((s: any) => (
                <div key={s.name} style={{
                  padding: "8px 10px", borderRadius: 6,
                  background: "var(--surface-hi)", border: "1px solid var(--border-soft)",
                }}>
                  <div style={{ fontSize: 11, color: "var(--ink-tertiary)" }}>{s.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ink-primary)" }}>
                    {typeof s.value === "number" ? s.value.toLocaleString() : s.value}
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty description="暂无数据" />}
        </Card>

        {/* Event stream */}
        <Card size="small" title={<span><SyncOutlined style={{ marginRight: 8 }} />飞轮事件流 (最近 15 条)</span>}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>
          ) : events.length > 0 ? (
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {events.map((ev, i) => (
                <div key={ev.id} style={{
                  display: "flex", gap: 8, alignItems: "center",
                  padding: "4px 0", borderBottom: i < events.length - 1 ? "1px solid var(--border-soft)" : "none",
                  fontSize: 12,
                }}>
                  <Tag color={stageColor[ev.stage] ?? "default"} style={{ fontSize: 10, margin: 0, minWidth: 64, textAlign: "center" }}>
                    {stageLabel[ev.stage] ?? ev.stage}
                  </Tag>
                  <span style={{ color: "var(--ink-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ev.sourceTitle}
                  </span>
                  {ev.targetType && (
                    <Tag style={{ fontSize: 10, margin: 0 }}>{ev.targetType}</Tag>
                  )}
                  <span style={{ color: "var(--ink-tertiary)", fontSize: 10, flexShrink: 0 }}>
                    {fmtTime(ev.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : <Empty description="暂无事件" />}
        </Card>
      </div>

      {/* ─── 2026-07-12 PHASE-B 版本联动 ─── */}
      <Card
        size="small"
        title={
          <Space>
            <LinkOutlined style={{ marginRight: 8 }} />
            <span>版本联动 · 过期记录</span>
            {stale && (stale.counts.knowledge + stale.counts.skill + stale.counts.practice) > 0 && (
              <Tag color="orange">{stale.counts.knowledge + stale.counts.skill + stale.counts.practice} 条待处理</Tag>
            )}
          </Space>
        }
        extra={
          <Tooltip title="Resolver 自动触发: memory/knowledge/practice 的 UPDATE/MERGE 会导致下游标 stale">
            <Tag color="blue">自动 · Phase B</Tag>
          </Tooltip>
        }
      >
        {loading ? (
          <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>
        ) : stale && (stale.counts.knowledge + stale.counts.skill + stale.counts.practice) > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {/* Knowledge */}
            <div>
              <div style={{ fontSize: 11, color: "var(--ink-tertiary)", marginBottom: 6 }}>
                Knowledge <Tag color="orange" style={{ marginLeft: 4 }}>{stale.counts.knowledge}</Tag>
              </div>
              {stale.knowledge.slice(0, 5).map((r) => (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "4px 6px",
                  background: "var(--surface-hi)", borderRadius: 4, marginBottom: 4, fontSize: 12,
                }}>
                  <Tooltip title={r.staleReason ?? ""}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.theme ?? r.id.substring(0, 12)}
                    </span>
                  </Tooltip>
                  <Popconfirm
                    title="清 stale 标记?"
                    description="将重置为 active, 不会删除记录"
                    okText="清"
                    cancelText="取消"
                    onConfirm={() => handleClearStale("knowledge", r.id)}
                  >
                    <Button size="small" type="text" icon={<ClearOutlined />} loading={clearingId === r.id} />
                  </Popconfirm>
                </div>
              ))}
              {stale.counts.knowledge > 5 && (
                <div style={{ fontSize: 11, color: "var(--ink-tertiary)", textAlign: "center", marginTop: 4 }}>
                  +{stale.counts.knowledge - 5} 条更多
                </div>
              )}
            </div>
            {/* Skill */}
            <div>
              <div style={{ fontSize: 11, color: "var(--ink-tertiary)", marginBottom: 6 }}>
                Skill <Tag color="orange" style={{ marginLeft: 4 }}>{stale.counts.skill}</Tag>
              </div>
              {stale.skill.slice(0, 5).map((r) => (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "4px 6px",
                  background: "var(--surface-hi)", borderRadius: 4, marginBottom: 4, fontSize: 12,
                }}>
                  <Tooltip title={r.staleReason ?? ""}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.theme ?? r.id.substring(0, 12)}
                    </span>
                  </Tooltip>
                  <Popconfirm
                    title="清 stale 标记?"
                    okText="清"
                    cancelText="取消"
                    onConfirm={() => handleClearStale("skill", r.id)}
                  >
                    <Button size="small" type="text" icon={<ClearOutlined />} loading={clearingId === r.id} />
                  </Popconfirm>
                </div>
              ))}
              {stale.counts.skill > 5 && (
                <div style={{ fontSize: 11, color: "var(--ink-tertiary)", textAlign: "center", marginTop: 4 }}>
                  +{stale.counts.skill - 5} 条更多
                </div>
              )}
            </div>
            {/* Practice */}
            <div>
              <div style={{ fontSize: 11, color: "var(--ink-tertiary)", marginBottom: 6 }}>
                Practice <Tag color="orange" style={{ marginLeft: 4 }}>{stale.counts.practice}</Tag>
              </div>
              {stale.practice.slice(0, 5).map((r) => (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "4px 6px",
                  background: "var(--surface-hi)", borderRadius: 4, marginBottom: 4, fontSize: 12,
                }}>
                  <Tooltip title={r.staleReason ?? ""}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.theme ?? r.id.substring(0, 12)}
                    </span>
                  </Tooltip>
                  <Popconfirm
                    title="清 stale 标记?"
                    okText="清"
                    cancelText="取消"
                    onConfirm={() => handleClearStale("practice", r.id)}
                  >
                    <Button size="small" type="text" icon={<ClearOutlined />} loading={clearingId === r.id} />
                  </Popconfirm>
                </div>
              ))}
              {stale.counts.practice > 5 && (
                <div style={{ fontSize: 11, color: "var(--ink-tertiary)", textAlign: "center", marginTop: 4 }}>
                  +{stale.counts.practice - 5} 条更多
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: 24, color: "var(--ink-tertiary)", fontSize: 13 }}>
            <CheckCircleOutlined style={{ color: "var(--status-ok)", marginRight: 8 }} />
            暂无过期记录 — 所有版本联动产物已同步
          </div>
        )}
      </Card>
    </div>
  );
}
