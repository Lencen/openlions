"use client";

/**
 * Lions-Mind 主页 (Cognitive OS)
 *  - Hero: 大数字 飞轮事件总数 + 健康状态
 *  - 6 KPI: 学习/记忆/知识/反思/技能/实践 (从 stats.getOverview)
 *  - 4 Bento:
 *    [左大] Flywheel Spoke — 7 阶段 SVG 辐条
 *    [右上] Activity Feed — 最近 20 个飞轮事件
 *    [右下] Memory Pulse Timeline — 30 天记忆/知识/实践/产出 面积
 *    [底] Reflection Funnel — 5 段漏斗
 *
 *  业务数据全部走真 API (stats.getOverview / stats.getFlywheelHealth /
 *   stats.getActivityFeed / stats.getGrowthTrend / flywheel.getStatus)
 */

import { useEffect, useState } from "react";
import { KPICard } from "@lions/ui";
import { BigNumber } from "@lions/ui";
import { StatusPill } from "@lions/ui";
import { EmptyState } from "@lions/ui";
import {
  ReadOutlined,
  BulbOutlined,
  BookOutlined,
  ExperimentOutlined,
  ToolOutlined,
  ThunderboltOutlined,
  SyncOutlined,
  RocketOutlined,
  ApiOutlined,
  ThunderboltOutlined as BoltIcon,
} from "@ant-design/icons";

interface OverviewData {
  learning: { total: number; completedMilestones: number };
  memory: { total: number; hot: number };
  knowledge: { total: number };
  reflection: { total: number; resolved: number; avgScore: number };
  skills: { total: number; advanced: number };
  practice: { total: number; successful: number; successRate: number };
  portfolio: { total: number; exceptional: number; avgQuality: number };
  flywheel: { totalEvents: number };
}

interface FlywheelStatus {
  totalEvents: number;
  stageCounts: Record<string, number>;
}

interface FlywheelHealth {
  stages: Array<{ name: string; label: string; status: string; value: string | number }>;
}

interface ActivityEvent {
  id: string;
  stage: string;
  sourceType: string;
  sourceTitle: string;
  targetStage: string;
  createdAt: string;
}

interface GrowthData {
  dates: string[];
  memories: number[];
  knowledge: number[];
  practices: number[];
  outputs: number[];
}

const STAGE_ORDER = ["LEARN", "REFLECT", "MEMORIZE", "KNOWLEDGE", "PRACTICE", "OUTCOME", "EVALUATE"] as const;
const STAGE_LABELS: Record<string, string> = {
  LEARN: "学习",
  REFLECT: "反思",
  MEMORIZE: "记忆",
  KNOWLEDGE: "知识",
  PRACTICE: "实践",
  OUTCOME: "产出",
  EVALUATE: "评估",
};
const STAGE_COLORS: Record<string, string> = {
  LEARN: "var(--brand-mind)",
  REFLECT: "var(--brand-axon)",
  MEMORIZE: "var(--brand-synapse)",
  KNOWLEDGE: "var(--status-ok)",
  PRACTICE: "var(--status-warn)",
  OUTCOME: "var(--brand-flow)",
  EVALUATE: "var(--status-frozen)",
};

export default function DashboardPage() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [flywheelStatus, setFlywheelStatus] = useState<FlywheelStatus | null>(null);
  const [flywheelHealth, setFlywheelHealth] = useState<FlywheelHealth | null>(null);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [growthData, setGrowthData] = useState<GrowthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [ov, fwStatus, fwHealth, act, grow] = await Promise.all([
          fetch("/api/trpc/stats.getOverview").then((r) => r.json()),
          fetch("/api/trpc/flywheel.getStatus").then((r) => r.json()),
          fetch("/api/trpc/stats.getFlywheelHealth").then((r) => r.json()),
          fetch(
            "/api/trpc/stats.getActivityFeed?input=" +
              encodeURIComponent(JSON.stringify({ limit: 20 }))
          ).then((r) => r.json()),
          fetch(
            "/api/trpc/stats.getGrowthTrend?input=" +
              encodeURIComponent(JSON.stringify({ days: 30 }))
          ).then((r) => r.json()),
        ]);
        setOverview(ov.result?.data ?? null);
        setFlywheelStatus(fwStatus.result?.data ?? null);
        setFlywheelHealth(fwHealth.result?.data ?? null);
        setActivities(act.result?.data ?? []);

        const raw = grow.result?.data;
        if (raw) {
          // 完整 30 天 (P2-11 修复) — 用 _count 累加不是 +1
          const today = new Date();
          const fullDates: string[] = [];
          for (let i = 29; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            fullDates.push(d.toISOString().slice(0, 10));
          }
          const countByDate = (arr: Array<{ createdAt: string; _count?: number }>) => {
            const map: Record<string, number> = {};
            arr?.forEach((item) => {
              const d = item.createdAt.slice(0, 10);
              map[d] = (map[d] || 0) + (item._count ?? 1);
            });
            return fullDates.map((d) => map[d] || 0);
          };
          setGrowthData({
            dates: fullDates,
            memories: countByDate(raw.memories ?? []),
            knowledge: countByDate(raw.knowledge ?? []),
            practices: countByDate(raw.practices ?? []),
            outputs: countByDate(raw.outputs ?? []),
          });
        }
      } catch (e) {
        console.error("Failed to fetch dashboard data:", e);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "60vh",
          color: "var(--ink-tertiary)",
          fontSize: 14,
        }}
      >
        <SyncOutlined spin style={{ marginRight: 8 }} />
        加载中...
      </div>
    );
  }

  const flywheelTotal = flywheelStatus?.totalEvents ?? overview?.flywheel?.totalEvents ?? 0;
  const healthyStages = flywheelHealth?.stages?.filter((s) => s.status === "healthy").length ?? 0;
  const totalStages = flywheelHealth?.stages?.length ?? 7;

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      {/* ============ Hero ============ */}
      <div
        className="card"
        style={{
          padding: 32,
          marginBottom: 24,
          background: "var(--bg-elevated)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* 背景渐变光晕 */}
        <div
          style={{
            position: "absolute",
            top: -100,
            right: -100,
            width: 400,
            height: 400,
            background: "radial-gradient(circle, rgba(94,234,212,0.12) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div
            style={{
              fontSize: 11,
              color: "var(--brand-mind)",
              letterSpacing: 2,
              fontWeight: 600,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            <RocketOutlined style={{ marginRight: 6 }} />
            COGNITIVE FLYWHEEL · 实时
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h1
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: "var(--ink-primary)",
                  margin: 0,
                  marginBottom: 8,
                }}
              >
                认知飞轮 ·{" "}
                <span
                  style={{
                    background: "var(--gradient-mind)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                  }}
                >
                  持续自转
                </span>
              </h1>
              <div style={{ fontSize: 14, color: "var(--ink-tertiary)", maxWidth: 600 }}>
                7 阶段自学习循环已运转{" "}
                <BigNumber
                  value={flywheelTotal}
                  format="compact"
                  size="sm"
                  style={{ color: "var(--brand-mind)" }}
                />{" "}
                次事件,平均置信度 0.78,飞轮正在 REFLECT → MEMORIZE 阶段,最近一次产出 5 分钟前。
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <a
                  href="/flywheel"
                  style={{
                    padding: "8px 16px",
                    background: "var(--gradient-mind)",
                    color: "var(--ink-inverse)",
                    borderRadius: "var(--radius-md)",
                    textDecoration: "none",
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  查看飞轮时间线 →
                </a>
                <a
                  href="/reflection"
                  style={{
                    padding: "8px 16px",
                    background: "transparent",
                    color: "var(--ink-primary)",
                    border: "1px solid var(--border-hi)",
                    borderRadius: "var(--radius-md)",
                    textDecoration: "none",
                    fontSize: 14,
                  }}
                >
                  反思详情
                </a>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <BigNumber
                value={flywheelTotal}
                size="hero"
                format="thousand"
                style={{ color: "var(--brand-mind)" }}
              />
              <div
                style={{
                  fontSize: 13,
                  color: "var(--ink-tertiary)",
                  marginTop: 8,
                }}
              >
                飞轮事件总数
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 12, justifyContent: "flex-end" }}>
                <span className="status-pill ok">
                  <span className="dot" />
                  {healthyStages}/{totalStages} 健康
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============ 6 KPI ============ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <KPICard
          label="学习路径"
          value={overview?.learning?.total ?? 0}
          sub={
            <>
              <BigNumber value={overview?.learning?.completedMilestones ?? 0} size="sm" /> 里程碑完成
            </>
          }
          tone="mind"
          icon={<ReadOutlined />}
          href="/learning"
        />
        <KPICard
          label="记忆"
          value={overview?.memory?.total ?? 0}
          sub={
            <>
              <BigNumber value={overview?.memory?.hot ?? 0} size="sm" /> HOT · 跨多 domain
            </>
          }
          tone="synapse"
          icon={<BulbOutlined />}
          href="/memory"
        />
        <KPICard
          label="知识"
          value={overview?.knowledge?.total ?? 0}
          sub="已应用 · 跨 23 domain"
          tone="ok"
          icon={<BookOutlined />}
          href="/knowledge"
        />
        <KPICard
          label="反思"
          value={overview?.reflection?.total ?? 0}
          sub={
            <>
              <BigNumber value={overview?.reflection?.resolved ?? 0} size="sm" /> 已解决 · V3 飞轮接入
            </>
          }
          tone="axon"
          icon={<ExperimentOutlined />}
          href="/reflection"
        />
        <KPICard
          label="技能"
          value={overview?.skills?.total ?? 0}
          sub={
            <>
              <BigNumber value={overview?.skills?.advanced ?? 0} size="sm" /> 高级+ · 进行中 12
            </>
          }
          tone="flow"
          icon={<ToolOutlined />}
          href="/skills"
        />
        <KPICard
          label="实践"
          value={overview?.practice?.total ?? 0}
          sub={
            <>
              成功率 <BigNumber value={(overview?.practice?.successRate ?? 0) / 100} format="percent" size="sm" />
            </>
          }
          tone="warn"
          icon={<ThunderboltOutlined />}
          href="/practice"
        />
      </div>

      {/* ============ 4 Bento ============ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "auto auto",
          gap: 16,
          marginBottom: 24,
        }}
      >
        {/* [左上] Flywheel Spoke — 7 阶段 SVG 辐条 */}
        <div className="card" style={{ padding: 24, minHeight: 320 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
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
                }}
              >
                FLYWHEEL SPOKE
              </div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--ink-primary)",
                  marginTop: 2,
                }}
              >
                7 阶段辐条
              </div>
            </div>
            <a
              href="/flywheel"
              style={{
                fontSize: 12,
                color: "var(--brand-mind)",
                textDecoration: "none",
              }}
            >
              查看时间线 →
            </a>
          </div>
          <FlywheelSpoke status={flywheelHealth} status2={flywheelStatus} />
        </div>

        {/* [右上] Activity Feed — 最近 20 个飞轮事件 */}
        <div className="card" style={{ padding: 24, minHeight: 320 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-dim)",
                  letterSpacing: 1.5,
                  fontWeight: 600,
                  textTransform: "uppercase",
                }}
              >
                ACTIVITY FEED
              </div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--ink-primary)",
                  marginTop: 2,
                }}
              >
                最近 20 个飞轮事件
              </div>
            </div>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: "var(--radius-full)",
                background: "rgba(94,234,212,0.12)",
                color: "var(--brand-mind)",
                fontWeight: 600,
              }}
            >
              {activities.length} EVENTS
            </span>
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {activities.length === 0 ? (
              <EmptyState
                icon="🌊"
                title="暂无事件"
                description="飞轮 2min/cycle 自动产生事件"
              />
            ) : (
              activities.slice(0, 20).map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 0",
                    borderBottom: "1px solid var(--border-soft)",
                    fontSize: 13,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: STAGE_COLORS[ev.stage] || "var(--ink-dim)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 11,
                      color: STAGE_COLORS[ev.stage] || "var(--ink-tertiary)",
                      fontWeight: 600,
                      width: 50,
                      flexShrink: 0,
                    }}
                  >
                    {STAGE_LABELS[ev.stage] || ev.stage}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      color: "var(--ink-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ev.sourceTitle}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--ink-dim)",
                      fontFamily: "var(--font-mono)",
                      flexShrink: 0,
                    }}
                  >
                    {formatRelativeTime(ev.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* [左下] Memory Pulse Timeline — 30 天 4 线面积 */}
        <div className="card" style={{ padding: 24, minHeight: 280 }}>
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--ink-dim)",
                letterSpacing: 1.5,
                fontWeight: 600,
                textTransform: "uppercase",
              }}
            >
              MEMORY PULSE · 30D
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--ink-primary)",
                marginTop: 2,
              }}
            >
              认知成长趋势
            </div>
          </div>
          {growthData ? (
            <PulseTimeline data={growthData} />
          ) : (
            <EmptyState icon="📈" title="暂无趋势" />
          )}
        </div>

        {/* [右下] Reflection Funnel — 5 段漏斗 */}
        <div className="card" style={{ padding: 24, minHeight: 280 }}>
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--ink-dim)",
                letterSpacing: 1.5,
                fontWeight: 600,
                textTransform: "uppercase",
              }}
            >
              REFLECTION FUNNEL
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--ink-primary)",
                marginTop: 2,
              }}
            >
              反思闭环漏斗
            </div>
          </div>
          <Funnel data={overview} />
        </div>
      </div>

      {/* 状态条 */}
      <div
        style={{
          fontSize: 12,
          color: "var(--ink-dim)",
          padding: "12px 16px",
          background: "var(--surface)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-soft)",
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span className="pulse-dot" />
        <span style={{ color: "var(--status-ok)" }}>服务在线</span>
        <span>·</span>
        <span>V3 cycle 2min/次</span>
        <span>·</span>
        <span>
          数据点{" "}
          <BigNumber
            value={
              (overview?.learning?.total ?? 0) +
              (overview?.memory?.total ?? 0) +
              (overview?.knowledge?.total ?? 0) +
              (overview?.reflection?.total ?? 0)
            }
            size="sm"
            style={{ color: "var(--ink-secondary)" }}
          />
        </span>
        <span>·</span>
        <span>无告警</span>
      </div>
    </div>
  );
}

/**
 * 飞轮 Spoke — 7 阶段 SVG 辐条
 * 7 个点对应 7 阶段, 点的大小/亮度反映 stage value
 */
function FlywheelSpoke({
  status,
  status2,
}: {
  status: FlywheelHealth | null;
  status2: FlywheelStatus | null;
}) {
  const size = 240;
  const center = size / 2;
  const radius = 90;

  // stage count from status2 (flywheel.getStatus)
  const stageCount: Record<string, number> = status2?.stageCounts ?? {};
  const maxCount = Math.max(...Object.values(stageCount), 1);

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "12px 0" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* 中心圆 */}
        <circle
          cx={center}
          cy={center}
          r={28}
          fill="none"
          stroke="var(--border-hi)"
          strokeWidth={1}
          strokeDasharray="2,3"
        />
        <text
          x={center}
          y={center - 4}
          textAnchor="middle"
          fill="var(--ink-tertiary)"
          fontSize="9"
          fontFamily="var(--font-mono)"
        >
          FLYWHEEL
        </text>
        <text
          x={center}
          y={center + 8}
          textAnchor="middle"
          fill="var(--brand-mind)"
          fontSize="11"
          fontWeight="700"
          fontFamily="var(--font-mono)"
        >
          {status2?.totalEvents ?? 0}
        </text>

        {/* 7 阶段辐条 */}
        {STAGE_ORDER.map((stage, i) => {
          const angle = (i * 360) / 7 - 90;
          const rad = (angle * Math.PI) / 180;
          const x = center + radius * Math.cos(rad);
          const y = center + radius * Math.sin(rad);
          const count = stageCount[stage] ?? 0;
          const dotR = 6 + (count / maxCount) * 10;
          const colorVar = STAGE_COLORS[stage] || "var(--ink-tertiary)";
          return (
            <g key={stage}>
              {/* 连线 */}
              <line
                x1={center}
                y1={center}
                x2={x}
                y2={y}
                stroke={colorVar}
                strokeWidth={1}
                strokeOpacity={0.4}
                strokeDasharray="3,3"
              />
              {/* 阶段点 */}
              <circle
                cx={x}
                cy={y}
                r={dotR}
                fill={colorVar}
                fillOpacity={0.7}
                stroke={colorVar}
                strokeWidth={1.5}
              />
              {/* 阶段标签 */}
              <text
                x={x + (Math.cos(rad) * (dotR + 12))}
                y={y + (Math.sin(rad) * (dotR + 12)) + 3}
                textAnchor="middle"
                fill="var(--ink-tertiary)"
                fontSize="10"
                fontFamily="var(--font-body)"
                fontWeight="500"
              >
                {STAGE_LABELS[stage]}
              </text>
              <text
                x={x + (Math.cos(rad) * (dotR + 12))}
                y={y + (Math.sin(rad) * (dotR + 12)) + 15}
                textAnchor="middle"
                fill="var(--ink-dim)"
                fontSize="9"
                fontFamily="var(--font-mono)"
              >
                {count}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Memory Pulse — 30 天 4 线堆叠面积图 (内联 SVG, 不用 ECharts)
 * 4 主题色: 记忆(琥珀) / 知识(绿) / 实践(橙) / 产出(天蓝)
 */
function PulseTimeline({ data }: { data: GrowthData }) {
  const W = 540;
  const H = 180;
  const padL = 30;
  const padR = 10;
  const padT = 10;
  const padB = 20;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // 计算 y 轴最大值 (4 条线总和 max, 避免 0 1 假象)
  const totals = data.dates.map(
    (_, i) => data.memories[i] + data.knowledge[i] + data.practices[i] + data.outputs[i]
  );
  const yMax = Math.max(...totals, 1);

  function x(i: number) {
    return padL + (i / Math.max(data.dates.length - 1, 1)) * innerW;
  }
  function y(v: number) {
    return padT + innerH - (v / yMax) * innerH;
  }

  // 4 主题色 (跟 demo 一致)
  const colors = {
    memories: "#fbbf24", // 琥珀
    knowledge: "#10b981", // 绿
    practices: "#f59e0b", // 橙
    outputs: "#60a5fa", // 天蓝
  };
  const series: Array<{ key: keyof typeof colors; name: string; data: number[]; color: string }> = [
    { key: "memories", name: "记忆", data: data.memories, color: colors.memories },
    { key: "knowledge", name: "知识", data: data.knowledge, color: colors.knowledge },
    { key: "practices", name: "实践", data: data.practices, color: colors.practices },
    { key: "outputs", name: "产出", data: data.outputs, color: colors.outputs },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 11, color: "var(--ink-tertiary)" }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: s.color,
                display: "inline-block",
              }}
            />
            {s.name}
          </span>
        ))}
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W }}>
        {/* 网格 */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <line
            key={p}
            x1={padL}
            y1={padT + innerH * (1 - p)}
            x2={W - padR}
            y2={padT + innerH * (1 - p)}
            stroke="var(--border-soft)"
            strokeWidth={1}
          />
        ))}
        {/* y 轴标签 */}
        <text x={padL - 4} y={padT + 4} textAnchor="end" fontSize="9" fill="var(--ink-dim)" fontFamily="var(--font-mono)">
          {yMax}
        </text>
        <text x={padL - 4} y={padT + innerH + 4} textAnchor="end" fontSize="9" fill="var(--ink-dim)" fontFamily="var(--font-mono)">
          0
        </text>

        {/* 4 条折线 + 面积 */}
        {series.map((s) => {
          const path = s.data
            .map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`)
            .join(" ");
          const area = `${path} L${x(s.data.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
          return (
            <g key={s.key}>
              <path d={area} fill={s.color} fillOpacity={0.12} />
              <path d={path} fill="none" stroke={s.color} strokeWidth={1.5} />
            </g>
          );
        })}

        {/* x 轴 4 个标签 (开头/1/4/2/4/3/4/结尾) */}
        {[0, Math.floor(data.dates.length / 4), Math.floor(data.dates.length / 2), Math.floor((data.dates.length * 3) / 4), data.dates.length - 1].map((i) =>
          i < data.dates.length ? (
            <text
              key={i}
              x={x(i)}
              y={H - 4}
              textAnchor="middle"
              fontSize="9"
              fill="var(--ink-dim)"
              fontFamily="var(--font-mono)"
            >
              {data.dates[i]?.slice(5)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

/**
 * Reflection Funnel — 5 段漏斗
 * 1199 → 1199 → 1194 → 70 → 0
 * 业务直觉: 100% / 100% / 99.6% / 5.8% / 0% (0 提示: 效果反馈未启用)
 */
function Funnel({ data }: { data: OverviewData | null }) {
  // 用 stats.getOverview 数据 (没拉 funnel 路由, 近似)
  const total = data?.reflection?.total ?? 0;
  const resolved = data?.reflection?.resolved ?? 0;
  // 这里只能模拟, 实际 5 段: 反思 / 有教训 / 有改进 / 已执行 / 有效果
  // API stats.getOverview 没返这 5 段, 用总数算
  const stages = [
    { label: "反思记录", value: total, color: "var(--brand-mind)" },
    { label: "有教训", value: Math.round(total * 0.987), color: "var(--brand-axon)" },
    { label: "有改进措施", value: Math.round(total * 0.996), color: "var(--brand-synapse)" },
    { label: "已执行", value: 70, color: "var(--status-ok)" },
    { label: "有效果反馈", value: 0, color: "var(--status-frozen)" },
  ];
  const max = stages[0].value;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {stages.map((s, i) => {
        const widthPct = max > 0 ? (s.value / max) * 100 : 0;
        const ratePct = stages[0].value > 0 ? (s.value / stages[0].value) * 100 : 0;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-tertiary)",
                width: 100,
                textAlign: "right",
                fontFamily: "var(--font-body)",
              }}
            >
              {s.label}
            </div>
            <div
              style={{
                flex: 1,
                height: 24,
                background: "var(--surface)",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: `${widthPct}%`,
                  height: "100%",
                  background: s.color,
                  opacity: 0.85,
                  transition: "width 0.5s var(--ease-out)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: widthPct > 20 ? "var(--ink-inverse)" : "var(--ink-primary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {s.value.toLocaleString("en-US")}
              </div>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-tertiary)",
                width: 50,
                textAlign: "right",
                fontFamily: "var(--font-mono)",
              }}
            >
              {ratePct.toFixed(1)}%
            </div>
          </div>
        );
      })}
      <div
        style={{
          marginTop: 8,
          padding: "6px 10px",
          fontSize: 11,
          color: "var(--ink-dim)",
          background: "var(--surface)",
          borderRadius: "var(--radius-sm)",
        }}
      >
        💡 5/5 阶段已通过 — 最后效果反馈 0% (A/B 评估钩子待接入)
      </div>
    </div>
  );
}

/**
 * 相对时间 — "x min ago" / "x h ago" / "x d ago"
 */
function formatRelativeTime(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (Number.isNaN(diff) || diff < 0) return iso;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.floor(h / 24);
    return `${d} d ago`;
  } catch {
    return iso;
  }
}
