"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { useWebSocket, type WsStatus } from "@/lib/ws-client";
import { THEMES, useTheme } from "@/lib/theme";

// ============ 常量 ============
const UTC8 = 8 * 60 * 60 * 1000;
const toBJ = (t: string | number) => new Date(new Date(t).getTime() + UTC8);
const fmtDT = (d: Date) => `${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;

// ============ 主题 ============
// 实际渲染时子组件作为 prop 接收 C, 这里是兜底
// 注: dashboard 自有 C 对象 (旧版 hex), 阶段 6 改为 CSS var() 引用 (走 tokens.css 4 主题)
const C_DEFAULT = {
  bg: "var(--bg-base)", surface: "var(--surface-hi)", border: "var(--border)",
  primary: "var(--brand-mind)", secondary: "var(--brand-synapse)", accent: "var(--brand-axon)",
  text: "var(--ink-primary)", muted: "var(--ink-tertiary)",
  success: "var(--status-ok)", warning: "var(--status-warn)", error: "var(--status-err)",
};
// 饼图 8 色 — 4 主题下都用 brand-* 4 色 + status-* 3 色 + 灰
const pieCols = [
  "var(--brand-mind)", "var(--brand-synapse)", "var(--status-warn)", "var(--status-ok)",
  "var(--status-err)", "var(--ink-tertiary)", "var(--brand-axon)", "var(--brand-flow)",
];

// ============ 样式 ============
// 样式已迁移到 src/app/globals.css(避免 Next.js dev mode 吞掉 <style>)
// ============ 类型 ============
interface ReasonDist { reason: string; count: number }
interface ThroughputWindow { window: string; tasks: number; problems: number; flywheel: number }
interface FlywheelStage { _count: number; stage: string }
interface TaskStats { _count: number; status: string }
interface ProblemStats { _count: number; status: string }
interface QueueDepth { _count: number; priority: string }
interface HourlyData { hour: number; tasks: number; problems: number }
interface RetryAnalysis { todayRetries: number; distribution: ReasonDist[] }
interface OverviewData {
  taskStats: TaskStats[]; taskExecStats: TaskStats[]; problemStats: ProblemStats[]; queueDepth: QueueDepth[];
  flywheelStages: FlywheelStage[]; currentlyProcessing: number; stuckCount: number;
  recentLogs: Array<{ id: string; status: string; qualityPassed: boolean|null; createdAt: string; task:{id:string;title:string}|null }>;
}
interface SchedulerEvent { taskScheduler?:{isActive:boolean;lastRun:string|null}; problemScheduler?:{isActive:boolean;lastRun:string|null} }
interface SchedulerEvents { events: Array<{type:string;timestamp:string;data:any}>; total:number }
interface RunningTask { executionId: string; taskId: string; title: string; priority: number|null; agentId: string; agentRole: string; startedAt: string; runningMs: number }
interface SolvingProblem { problemId: string; severity: string; description: string; lastAttemptAt: string; runningMs: number }
interface TaskResourceData {
  engineType: "task"; runningCount: number; stuckCount: number; batchSize: number;
  pendingCount: number; utilizationPct: number;
  smartMode: boolean;
  batchOverride: number | null; batchDefault: number;
  runningTasks: RunningTask[]; serverTime: string;
}
interface ProblemResourceData {
  engineType: "problem"; runningCount: number; stuckCount: number; batchSize: number;
  pendingCount: number; utilizationPct: number;
  smartMode: boolean;
  batchOverride: number | null; batchDefault: number;
  solvingProblems: SolvingProblem[]; serverTime: string;
}

// ============ 渲染饼图路径 ============
const piePath = (startAngle: number, angle: number) => {
  if (angle === 0) return "";
  const sr = (startAngle - 90) * Math.PI / 180;
  const er = (startAngle + angle - 90) * Math.PI / 180;
  const la = angle > 180 ? 1 : 0;
  const x1 = 50 + 40 * Math.cos(sr), y1 = 50 + 40 * Math.sin(sr);
  const x2 = 50 + 40 * Math.cos(er), y2 = 50 + 40 * Math.sin(er);
  if (angle >= 360) return `M 50 10 A 40 40 0 1 1 49.99 10 Z`;
  return `M 50 50 L ${x1} ${y1} A 40 40 0 ${la} 1 ${x2} ${y2} Z`;
};

// ============ 渲染饼图组件 ============
const PieChart = ({ dist, total, C = C_DEFAULT }: { dist: ReasonDist[]; total: number; C?: typeof C_DEFAULT }) => {
  if (!dist || dist.length === 0) return <div style={{textAlign:"center",color:C.muted,fontSize:12,padding:20}}>暂无数据</div>;
  // 如果只有一个分类且占比100%，直接画一个完整圆
  if (dist.length === 1 && total > 0) {
    return (
      <div className="pie-wrap">
        <svg className="pie-svg" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill={pieCols[0]} />
          <circle cx="50" cy="50" r="25" fill={C.bg} />
        </svg>
        <div className="pie-legend">
          <div className="pie-item">
            <div className="pie-dot" style={{background:pieCols[0]}} />
            <span style={{color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:100}}>{dist[0].reason}</span>
            <span style={{color:C.muted,flexShrink:0}}>{dist[0].count}</span>
          </div>
        </div>
      </div>
    );
  }
  let cumAngle = 0;
  const slices = dist.map((d, i) => {
    const ang = total > 0 ? (d.count / total) * 360 : 0;
    const sa = cumAngle; cumAngle += ang;
    return { ...d, startAngle: sa, angle: ang, color: pieCols[i % pieCols.length] };
  });
  return (
    <div className="pie-wrap">
      <svg className="pie-svg" viewBox="0 0 100 100">
        {slices.map((s, i) => {
          if (s.angle === 0) return null;
          const sr = (s.startAngle - 90) * Math.PI / 180;
          const er = (s.startAngle + s.angle - 90) * Math.PI / 180;
          const la = s.angle > 180 ? 1 : 0;
          const x1 = 50 + 40 * Math.cos(sr), y1 = 50 + 40 * Math.sin(sr);
          const x2 = 50 + 40 * Math.cos(er), y2 = 50 + 40 * Math.sin(er);
          if (s.angle >= 360) return <circle key={i} cx="50" cy="50" r="40" fill={s.color} />;
          return <path key={i} d={`M 50 50 L ${x1} ${y1} A 40 40 0 ${la} 1 ${x2} ${y2} Z`} fill={s.color} />;
        })}
        <circle cx="50" cy="50" r={total === 0 ? 40 : 25} fill={C.bg} />
      </svg>
      <div className="pie-legend">
        {slices.map((s, i) => (
          <div key={i} className="pie-item">
            <div className="pie-dot" style={{background:s.color}} />
            <span style={{color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:100}}>{s.reason}</span>
            <span style={{color:C.muted,flexShrink:0}}>{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ============ 主组件 ============
export default function DashboardPage() {
  // 主题: 用 shared useTheme(跟 FloatingThemeSwitcher 自动同步)
  // SSR 时 window 不存在, 所以 useTheme 初始 mode='dark', const C 总是 dark 配色
  // 客户端 mount 后 useEffect 会触发 re-render, const C 重新赋值
  const { mode, resolved, setMode } = useTheme();
  // 主题色板: 走 CSS var() 4 主题 (dark/light/glass/mono 自动切)
  // 旧版有 light/dark 两套 hex, 阶段 6 统一改 var() 引用
  const C = {
    bg: "var(--bg-base)", surface: "var(--surface-hi)", border: "var(--border)",
    primary: "var(--brand-mind)", secondary: "var(--brand-synapse)", accent: "var(--brand-axon)",
    text: "var(--ink-primary)", muted: "var(--ink-tertiary)",
    success: "var(--status-ok)", warning: "var(--status-warn)", error: "var(--status-err)",
  };
  // 抑制未用警告
  void mode; void setMode;

  // debug
  if (typeof window !== "undefined") {
    console.log("[Dashboard] resolved=", resolved, "C.bg=", C.bg);
  }

  // 强制客户端 mount 后 re-render(useTheme 监听 URL, 但 SSR 后需要 setState 触发)
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) {
    // SSR 阶段: 用 useTheme 的 initialMode 决定的 const C(暗色)
    // mount 后 useEffect 触发 re-render, 走 useTheme 实际 resolved
  }

  const [currentTime, setCurrentTime] = useState("");

  const STAGE_NAMES: Record<string, string> = {
    SCAN: "扫描", MEMORY: "记忆", KNOWLEDGE: "知识", REFLECTION: "反思",
    TASK_CREATE: "任务创建", TASK_COMPLETE: "任务完成", PROBLEM_SOLVE: "问题解决",
    PRACTICE: "实践", OUTCOME: "成果", EVALUATE: "评估", LEARN: "学习",
    MEMORIZE: "记忆2", SYNC: "同步",
    KNOWLEDGE_INTEGRATED: "知识融合", REFLECTION_TASK: "任务反思",
    FLUSH: "清空",
    PROBLEM_CREATED: "问题创建", PROBLEM_SOLVED: "问题解决",
  };
  const stageName = (s: string) => STAGE_NAMES[s] || s.replace(/_/g, " ");

  const typeName = (t: string) => {
    const map: Record<string, string> = {
      "TASK_SCAN": "扫描任务", "TASK_CREATED": "任务已创建", "TASK_COMPLETED": "任务完成",
      "TASK_FAILED": "任务失败", "TASK_BLOCKED": "任务阻塞", "TASK_RETRY": "任务重试",
      "TASK_STARTED": "任务开始", "TASK_STATUS_CHANGED": "状态变更",
      "TASK_PROCESS_START": "任务处理开始", "TASK_PROCESS_COMPLETE": "任务处理完成",
      "PROBLEM_FOUND": "发现问题", "PROBLEM_SOLVED": "问题已解决", "PROBLEM_ABANDONED": "问题废弃",
      "PROBLEM_CREATED": "问题已创建", "PROBLEM_RESOLVED": "问题已处理",
      "PROBLEM_STATUS_CHANGED": "问题状态变更",
      "PROBLEM_PROCESS_START": "问题处理开始", "PROBLEM_PROCESS_COMPLETE": "问题处理完成",
      "MEMORY_WRITTEN": "记忆写入", "KNOWLEDGE_UPDATED": "知识更新", "REFLECTION_GENERATED": "反思生成",
      "FLYWHEEL_SPUN": "飞轮转动", "SESSION_SCANNED": "会话扫描",
      "TASK_SCHEDULER_RUN": "任务调度运行", "PROBLEM_SCHEDULER_RUN": "问题调度运行",
      "STUCK_TASK_GUARD_RUN": "卡顿任务检测",
      "REVIEW_CREATED": "评审已创建", "REVIEW_COMPLETED": "评审完成",
      "SCHEDULER_TASK_BATCH_COMPLETE": "任务批次完成", "SCHEDULER_TASK_BATCH_START": "任务批次开始",
      "SCHEDULER_PROBLEM_BATCH_COMPLETE": "问题批次完成", "SCHEDULER_PROBLEM_BATCH_START": "问题批次开始",
      "SCHEDULER_TICK": "调度心跳", "EXECUTION_RECORDED": "执行记录",
    };
    return map[t] || t;
  };

  const queryClient = useQueryClient();
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");

  // ── WebSocket 实时订阅 (dashboard:overview) ──
  // refetchInterval 仅在 WS 断开时作为降级兜底
  const { data: overview } = useQuery<OverviewData>({
    queryKey: ["dashboard", "overview"],
    queryFn: () => fetch("/api/trpc/dashboard.overview").then(r => r.json()).then(r => r.result.data),
    refetchInterval: wsStatus === "open" ? false : 10000,
    refetchIntervalInBackground: true,
  });
  // P1-9: health 拉飞轮 24h/1h 真实数据(跟 mind/flywheel 一致)
  const { data: health } = useQuery<any>({
    queryKey: ["dashboard", "health"],
    queryFn: () => fetch("/api/trpc/health.report").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 15000,
  });
  const flywheel24h = health?.flywheel?.events24h ?? 0;
  const flywheel1h = health?.flywheel?.events1h ?? 0;
  const flywheelState = health?.flywheel?.state ?? "stalled";
  const reflectionCount24h = health?.reflection?.events24h ?? 0;
  // 并行资源面板(任务端 + 问题端,5s 轮询) — WS 未连接时作为降级
  const { data: taskResources, refetch: refetchTaskRes } = useQuery<TaskResourceData>({
    queryKey: ["dashboard", "taskResources"],
    queryFn: () => fetch("/api/trpc/dashboard.taskResources").then(r => r.json()).then(r => r.result.data),
    refetchInterval: wsStatus === "open" ? false : 5000,
    refetchIntervalInBackground: true,
  });
  const { data: problemResources, refetch: refetchProbRes } = useQuery<ProblemResourceData>({
    queryKey: ["dashboard", "problemResources"],
    queryFn: () => fetch("/api/trpc/dashboard.problemResources").then(r => r.json()).then(r => r.result.data),
    refetchInterval: wsStatus === "open" ? false : 5000,
    refetchIntervalInBackground: true,
  });

  // 订阅 ws-server: 3003 上的 dashboard:overview
  useWebSocket(
    typeof window !== "undefined" ? `ws://${window.location.hostname}:3003` : "ws://localhost:3003",
    {
      channels: ["dashboard:overview"],
      onStatusChange: setWsStatus,
      onMessage: (frame) => {
        if (frame.channel === "dashboard:overview" && frame.data) {
          queryClient.setQueryData(["dashboard", "overview"], frame.data);
        } else if (frame.channel === "dashboard:resources:task" && frame.data) {
          queryClient.setQueryData(["dashboard", "taskResources"], frame.data);
        } else if (frame.channel === "dashboard:resources:problem" && frame.data) {
          queryClient.setQueryData(["dashboard", "problemResources"], frame.data);
        }
      },
    }
  );

  // 调整 batch 状态(控制输入框显示)
  const [editingBatch, setEditingBatch] = useState<"task" | "problem" | null>(null);
  const [batchInput, setBatchInput] = useState<string>("");
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchMsg, setBatchMsg] = useState<string>("");
  const [smartToggle, setSmartToggle] = useState<boolean>(true);

  const openBatchEditor = (engine: "task" | "problem", current: number) => {
    setEditingBatch(engine);
    setBatchInput(String(current));
    setBatchMsg("");
    // 初始化智能模式状态
    const cur = engine === "task" ? taskResources?.smartMode : problemResources?.smartMode;
    setSmartToggle(cur ?? true);
  };

  const submitBatch = async () => {
    if (!editingBatch) return;
    const v = batchInput.trim();
    setBatchSaving(true);
    setBatchMsg("");
    try {
      // 智能模式 ON → value 留空(用公式)
      // 智能模式 OFF → value 必填(1-200)
      if (!smartToggle) {
        const value = Number(v);
        if (v === "" || !Number.isInteger(value) || value < 1 || value > 200) {
          setBatchMsg("固定模式必须填 1-200 整数");
          setBatchSaving(false);
          return;
        }
      }
      const value = v === "" ? null : Number(v);
      const resp = await fetch("/api/trpc/dashboard.setBatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: editingBatch, value, smartMode: smartToggle }),
      }).then(r => r.json());
      const m = resp?.result?.data;
      if (m?.message) {
        setBatchMsg(m.message);
        if (editingBatch === "task") refetchTaskRes(); else refetchProbRes();
        setTimeout(() => { setEditingBatch(null); setBatchMsg(""); }, 1500);
      } else {
        setBatchMsg("失败:" + JSON.stringify(resp?.error || resp));
      }
    } catch (e: any) {
      setBatchMsg("网络错误:" + e.message);
    } finally {
      setBatchSaving(false);
    }
  };

  const cancelBatch = () => {
    setEditingBatch(null);
    setBatchInput("");
    setBatchMsg("");
  };

  // 智能模式快捷开关
  const toggleSmartMode = async (engine: "task" | "problem") => {
    const cur = engine === "task" ? taskResources?.smartMode : problemResources?.smartMode;
    const newMode = !cur;
    setBatchSaving(true);
    setBatchMsg("");
    try {
      // 切换智能模式时,智能 ON 传 value=null(用公式),智能 OFF 保持当前 batchSize 或用 default
      const curBatch = engine === "task" ? (taskResources?.batchSize ?? 10) : (problemResources?.batchSize ?? 50);
      const value = newMode ? null : (curBatch || (engine === "task" ? 10 : 50));
      const resp = await fetch("/api/trpc/dashboard.setBatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine, value, smartMode: newMode }),
      }).then(r => r.json());
      const m = resp?.result?.data;
      setBatchMsg(m?.message || "已切换");
      if (engine === "task") refetchTaskRes(); else refetchProbRes();
      setTimeout(() => setBatchMsg(""), 1500);
    } catch (e: any) {
      setBatchMsg("网络错误:" + e.message);
    } finally {
      setBatchSaving(false);
    }
  };
  const { data: hourly } = useQuery<HourlyData[]>({
    queryKey: ["dashboard", "hourlyTrend"],
    queryFn: () => fetch("/api/trpc/dashboard.getHourlyTrend").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 60000,
  });
  const { data: throughput } = useQuery<ThroughputWindow[]>({
    queryKey: ["dashboard", "throughput"],
    queryFn: () => fetch("/api/trpc/dashboard.getThroughputPer10Min").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 30000,
  });
  const { data: failedDist } = useQuery<ReasonDist[]>({
    queryKey: ["dashboard", "failedDist"],
    queryFn: () => fetch("/api/trpc/dashboard.getFailedReasonDistribution").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 30000,
  });
  const { data: retryData } = useQuery<RetryAnalysis>({
    queryKey: ["dashboard", "retryDist"],
    queryFn: () => fetch("/api/trpc/dashboard.getRetryReasonDistribution").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 30000,
  });
  const { data: blockedDist } = useQuery<ReasonDist[]>({
    queryKey: ["dashboard", "blockedDist"],
    queryFn: () => fetch("/api/trpc/dashboard.getBlockedReasonDistribution").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 30000,
  });
  const { data: cancelledDist } = useQuery<ReasonDist[]>({
    queryKey: ["dashboard", "cancelledDist"],
    queryFn: () => fetch("/api/trpc/dashboard.getCancelledReasonDistribution").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 30000,
  });
  const { data: abandonedDist } = useQuery<ReasonDist[]>({
    queryKey: ["dashboard", "abandonedDist"],
    queryFn: () => fetch("/api/trpc/dashboard.getAbandonedReasonDistribution").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 30000,
  });
  const { data: scheduler } = useQuery<SchedulerEvent>({
    queryKey: ["schedulerEvent", "status"],
    queryFn: () => fetch("/api/trpc/schedulerEvent.getStatus").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 5000,
  });
  const { data: schedulerEvents } = useQuery<SchedulerEvents>({
    queryKey: ["schedulerEvent", "events"],
    queryFn: () => fetch("/api/trpc/schedulerEvent.getEvents?input=%7B%22limit%22%3A30%7D").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 5000,
  });
  const taskLogRef = useRef<HTMLDivElement>(null);
  const problemLogRef = useRef<HTMLDivElement>(null);

  // 自动滚动到顶部
  useEffect(() => {
    if (schedulerEvents?.events?.length) {
      taskLogRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      problemLogRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [schedulerEvents?.events]);

  useEffect(() => {
    const update = () => {
      const d = new Date(new Date().getTime() + UTC8);
      setCurrentTime(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`);
    };
    update(); const iv = setInterval(update, 1000); return () => clearInterval(iv);
  }, []);

  // Maps
  const taskMap: Record<string, number> = {};
  overview?.taskStats.forEach(t => { taskMap[t.status] = t._count; });
  // 任务执行(Execution 表)用于显示"进行中",因为 Task 表没有 IN_PROGRESS 状态
  const taskExecMap: Record<string, number> = {};
  overview?.taskExecStats?.forEach(t => { taskExecMap[t.status] = t._count; });
  const problemMap: Record<string, number> = {};
  overview?.problemStats.forEach(p => { problemMap[p.status] = p._count; });
  const queueMap: Record<string, number> = {};
  overview?.queueDepth.forEach(q => { queueMap[q.priority] = q._count; });

  const totalTasks = Object.values(taskMap).reduce((a, b) => a + b, 0);
  const totalProblems = Object.values(problemMap).reduce((a, b) => a + b, 0);

  // KPI 数据语义:
  //   待处理 = Task.PENDING(队列中等待执行)
  //   进行中 = TaskExecution.IN_PROGRESS(正在跑的执行)
  //   卡住   = TaskExecution.IN_PROGRESS 跑超 30min(需要清理)
  //   阻塞   = Task.BLOCKED(等前置依赖,正常状态)
  //   失败   = Task.FAILED(执行失败)
  //   已完成 = Task.COMPLETED
  //   已取消 = Task.CANCELLED
  const pending = taskMap["PENDING"] ?? 0;
  const inProgress = taskExecMap["IN_PROGRESS"] ?? 0;
  const stuck = overview?.stuckCount ?? 0;
  const completed = taskMap["COMPLETED"] ?? 0;
  const failed = taskMap["FAILED"] ?? 0;
  const blocked = taskMap["BLOCKED"] ?? 0;
  const cancelled = taskMap["CANCELLED"] ?? 0;

  // 漏斗
  const funnelMax = Math.max(pending, inProgress, stuck, completed, 1);

  // 每小时趋势
  const hourlyTrend = hourly ?? Array.from({length:24},(_,i)=>({hour:i,tasks:0,problems:0}));

  // 调度器事件 - 显示有意义的事件，跳过心跳
  const taskEvents = schedulerEvents?.events?.filter(e =>
    e.type === "TASK_COMPLETED" || e.type === "TASK_FAILED" || e.type === "TASK_RETRY" || e.type === "TASK_BLOCKED"
  ) ?? [];
  const problemEvents = schedulerEvents?.events?.filter(e =>
    e.type === "PROBLEM_CREATED" || e.type === "PROBLEM_SOLVED" || e.type === "PROBLEM_FAILED"
  ) ?? [];

  // 每10分钟吞吐量
  const recentWin = throughput && throughput.length > 0 ? throughput[throughput.length - 1] : null;

  if (!overview) return <div style={{padding:48,textAlign:"center",color:C.muted}}>加载中...</div>;

  const kpiCard = (label: string, value: number, color: string, pct: number) => (
    <div className="kpi">
      <div className="kpi-l">{label}</div>
      <div className="kpi-v" style={{color}}>{value}</div>
      <div className="kpi-bar"><div className="kpi-bar-fi" style={{width:`${pct}%`,background:color}} /></div>
    </div>
  );

  return (
    <>
      {/* 样式已迁移到 src/app/globals.css */}
      <div className="db">
        {/* Header */}
        <div className="hdr">
          <h1>📊 数据驾驶舱 · Dashboard</h1>
          <div className="hdr-time">北京时间 {currentTime}</div>
        </div>

        {/* 问题自动化状态 */}
        {problemMap["OPEN"] === 0 && problemMap["SOLVING"] > 0 && (
          <div className="status-msg">
            <span>✓</span>
            <span className="txt">问题自动化运行中 · {problemMap["SOLVING"]} 个问题正在处理</span>
          </div>
        )}

        {/* ===== 第1行：任务统计 KPI ===== */}
        <div className="sec">📊 任务统计</div>
        <div className="kpi-row">
          {kpiCard("总计", totalTasks, "var(--ink-primary)", 100)}
          {kpiCard("待处理", pending, "var(--status-warn)", totalTasks > 0 ? pending/totalTasks*100 : 0)}
          {kpiCard("进行中", inProgress, "var(--brand-mind)", totalTasks > 0 ? inProgress/totalTasks*100 : 0)}
          {kpiCard("卡住", stuck, stuck > 0 ? "var(--status-err)" : "#10b981", totalTasks > 0 ? stuck/totalTasks*100 : 0)}
          {kpiCard("已完成", completed, "#10b981", totalTasks > 0 ? completed/totalTasks*100 : 0)}
          {kpiCard("失败", failed, "var(--status-err)", totalTasks > 0 ? failed/totalTasks*100 : 0)}
          {kpiCard("阻塞", blocked, "var(--status-warn)", totalTasks > 0 ? blocked/totalTasks*100 : 0)}
          {kpiCard("已取消", cancelled, "var(--ink-tertiary)", totalTasks > 0 ? cancelled/totalTasks*100 : 0)}
        </div>

        {/* P1-9: 飞轮 24h/1h KPI (跟 mind/flywheel 数据一致) */}
        <div className="kpi-row" style={{ marginTop: 8 }}>
          {kpiCard(
            "飞轮24h事件",
            flywheel24h,
            "var(--brand-synapse)",
            Math.min(flywheel24h / 1000 * 100, 100)
          )}
          {kpiCard(
            "飞轮1h事件",
            flywheel1h,
            "var(--brand-synapse)",
            Math.min(flywheel1h / 100 * 100, 100)
          )}
          {kpiCard(
            "反思24h",
            reflectionCount24h,
            "var(--brand-mind)",
            Math.min(reflectionCount24h / 100 * 100, 100)
          )}
          {kpiCard(
            "飞轮状态",
            flywheelState === "spinning" ? 3 : flywheelState === "slow" ? 2 : flywheelState === "idle" ? 1 : 0,
            flywheelState === "spinning" ? "#10b981" : flywheelState === "slow" ? "var(--status-warn)" : flywheelState === "idle" ? "var(--status-warn)" : "var(--status-err)",
            flywheelState === "spinning" ? 100 : flywheelState === "slow" ? 66 : flywheelState === "idle" ? 33 : 0
          )}
        </div>

        {/* ===== 第2行：问题统计（一行） ===== */}
        <div className="sec">⚠️ 问题统计</div>
        <div className="kpi-row" style={{marginBottom:21}}>
          <div className="kpi"><div className="kpi-l">总计</div><div className="kpi-v" style={{color:"var(--ink-primary)"}}>{totalProblems}</div><div className="kpi-bar"><div className="kpi-bar-fi" style={{width:"100%",background:"linear-gradient(90deg,var(--brand-mind),var(--brand-flow))"}}/></div></div>
          <div className="kpi"><div className="kpi-l">待解决</div><div className="kpi-v" style={{color:"var(--status-err)"}}>{problemMap["OPEN"] ?? 0}</div><div className="kpi-bar"><div className="kpi-bar-fi" style={{width:totalProblems>0?(problemMap["OPEN"]??0)/totalProblems*100:0+"%",background:"var(--status-err)"}}/></div></div>
          <div className="kpi"><div className="kpi-l">处理中</div><div className="kpi-v" style={{color:"var(--status-warn)"}}>{problemMap["SOLVING"] ?? 0}</div><div className="kpi-bar"><div className="kpi-bar-fi" style={{width:totalProblems>0?(problemMap["SOLVING"]??0)/totalProblems*100:0+"%",background:"var(--status-warn)"}}/></div></div>
          <div className="kpi"><div className="kpi-l">已解决</div><div className="kpi-v" style={{color:"#10b981"}}>{problemMap["SOLVED"] ?? 0}</div><div className="kpi-bar"><div className="kpi-bar-fi" style={{width:totalProblems>0?(problemMap["SOLVED"]??0)/totalProblems*100:0+"%",background:"#10b981"}}/></div></div>
          <div className="kpi"><div className="kpi-l">已废弃</div><div className="kpi-v" style={{color:"var(--ink-tertiary)"}}>{problemMap["ABANDONED"] ?? 0}</div><div className="kpi-bar"><div className="kpi-bar-fi" style={{width:totalProblems>0?(problemMap["ABANDONED"]??0)/totalProblems*100:0+"%",background:"var(--ink-tertiary)"}}/></div></div>
        </div>

        {/* ===== 资源投入与并行任务面板(左右两引擎独立,等宽) ===== */}
        <div className="sec">⚙️ 资源投入与并行任务</div>
        <div className="res-eq">
          {/* === 左侧：任务资源引擎 === */}
          <div className="panel">
            <div className="panel-hdr">
              <div className="panel-ttl">📋 任务引擎</div>
              <div className="res-hdr">
                {editingBatch === "task" ? (
                  <div style={{display:"flex",gap:6,alignItems:"center",background:"rgba(0,0,0,.3)",padding:"3px 8px",borderRadius:10}}>
                    <label style={{display:"flex",alignItems:"center",gap:3,fontSize:10,color: smartToggle ? C.accent : C.muted,cursor:"pointer"}}>
                      <input type="checkbox" checked={smartToggle} onChange={e => setSmartToggle(e.target.checked)} style={{margin:0,cursor:"pointer"}} />
                      智能
                    </label>
                    <input
                      type="number" min={1} max={200}
                      value={batchInput}
                      onChange={e => setBatchInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") submitBatch(); if (e.key === "Escape") cancelBatch(); }}
                      autoFocus
                      disabled={smartToggle}
                      style={{width:50,fontSize:11,padding:"1px 4px",background: smartToggle ? "rgba(100,116,139,.1)" : "rgba(255,255,255,.05)",border: smartToggle ? "1px solid rgba(100,116,139,.3)" : "1px solid rgba(168,85,247,.5)",borderRadius:4,color: smartToggle ? C.muted : C.text,outline:"none",fontFamily:"inherit",cursor: smartToggle ? "not-allowed" : "text"}}
                      placeholder={smartToggle ? "智能模式" : "1-200"}
                    />
                    <button className="res-btn" onClick={submitBatch} disabled={batchSaving} style={{padding:"1px 6px"}}>{batchSaving ? "…" : "✓"}</button>
                    <button className="res-btn" onClick={cancelBatch} style={{padding:"1px 6px",background:"rgba(100,116,139,.2)",color:"var(--ink-tertiary)"}}>✕</button>
                  </div>
                ) : (
                  <button
                    className="res-btn"
                    onClick={() => openBatchEditor("task", taskResources?.batchSize ?? 10)}
                    title={taskResources?.batchOverride ? `当前固定值 ${taskResources.batchSize},智能模式 ${taskResources.smartMode ? "开" : "关"}` : `智能模式:${taskResources?.smartMode ? "开(按队列公式)" : "关"}`}
                  >⚙ 调整</button>
                )}
                <div className="panel-badge" style={{background: (taskResources?.stuckCount ?? 0) > 0 ? "rgba(239,68,68,.2)" : "rgba(16,185,129,.2)", color: (taskResources?.stuckCount ?? 0) > 0 ? "var(--status-err)" : "#10b981"}}>
                  {taskResources ? `${taskResources.runningCount} 任务在跑` : "加载中…"}
                </div>
              </div>
            </div>
            {editingBatch === "task" && batchMsg && (
              <div style={{fontSize:11,padding:"4px 8px",marginBottom:8,background: batchMsg.startsWith("已") ? "rgba(16,185,129,.1)" : "rgba(245,158,11,.1)",border:`1px solid ${batchMsg.startsWith("已") ? "rgba(16,185,129,.3)" : "rgba(245,158,11,.3)"}`,borderRadius:4,color: batchMsg.startsWith("已") ? "#10b981" : "var(--status-warn)"}}>
                {batchMsg}
              </div>
            )}
            <div className="res-grid" style={{gridTemplateColumns:"repeat(2,1fr)"}}>
              <div className="res-card">
                <div className="l">运行中</div>
                <div className="v" style={{color:C.primary}}>{taskResources?.runningCount ?? "-"}</div>
                <div className="s">TaskExecution.IN_PROGRESS</div>
              </div>
              <div className={`res-card ${(taskResources?.stuckCount ?? 0) > 0 ? "err" : ""}`}>
                <div className="l">卡住 &gt;30min</div>
                <div className="v" style={{color: (taskResources?.stuckCount ?? 0) > 0 ? C.error : C.success}}>
                  {taskResources?.stuckCount ?? "-"}
                </div>
                <div className="s">需清理</div>
              </div>
              <div className="res-card">
                <div className="l">batch 上限</div>
                <div className="v" style={{color: taskResources?.batchOverride ? C.warning : C.accent}}>{taskResources?.batchSize ?? "-"}</div>
                <div className="s">{taskResources?.smartMode ? "🧠 智能模式" : taskResources?.batchOverride ? `固定 ${taskResources.batchOverride}` : "固定默认"}</div>
              </div>
              <div className="res-card">
                <div className="l">待处理</div>
                <div className="v" style={{color:C.muted}}>{taskResources?.pendingCount ?? "-"}</div>
                <div className="s">PENDING</div>
              </div>
            </div>
            <div className="res-util">
              <div
                className={`res-util-fi ${(taskResources?.utilizationPct ?? 0) > 100 ? "over" : ""}`}
                style={{width: `${Math.min(taskResources?.utilizationPct ?? 0, 100)}%`}}
              />
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted,marginBottom:8}}>
              <span style={{color: (taskResources?.utilizationPct ?? 0) > 100 ? C.error : C.muted, fontWeight: (taskResources?.utilizationPct ?? 0) > 100 ? 700 : 400}}>
                占用率 {Math.min(taskResources?.utilizationPct ?? 0, 100)}%
                {(taskResources?.utilizationPct ?? 0) > 100 && (
                  <span style={{marginLeft:6,fontSize:10,padding:"1px 5px",background:"rgba(239,68,68,0.15)",borderRadius:4}}>
                    ⚠ 超载 {taskResources?.utilizationPct}%
                  </span>
                )}
              </span>
              <span>独立调度·scheduler.ts</span>
            </div>
            <div className="res-col-title" style={{marginTop:6}}>
              <span>🟢 正在跑</span>
              <span style={{color: C.primary}}>{taskResources?.runningTasks.length ?? 0}</span>
            </div>
            <div className="res-scroll">
              {!taskResources || taskResources.runningTasks.length === 0 ? (
                <div className="res-empty">暂无在跑任务</div>
              ) : (
                taskResources.runningTasks.map(t => {
                  const stuck = t.runningMs > 30 * 60 * 1000;
                  const mins = (t.runningMs / 60000).toFixed(1);
                  const pri = t.priority ? `P${t.priority}` : "?";
                  return (
                    <div key={t.executionId} className={`res-row ${stuck ? "stuck" : ""}`}>
                      <div className={`res-pri ${pri}`}>{pri}</div>
                      <div className="res-title" title={t.title}>{t.title}</div>
                      <div className={`res-meta ${stuck ? "stuck" : ""}`}>{mins}m</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* === 右侧：问题资源引擎 === */}
          <div className="panel">
            <div className="panel-hdr">
              <div className="panel-ttl">⚠️ 问题引擎</div>
              <div className="res-hdr">
                {editingBatch === "problem" ? (
                  <div style={{display:"flex",gap:6,alignItems:"center",background:"rgba(0,0,0,.3)",padding:"3px 8px",borderRadius:10}}>
                    <label style={{display:"flex",alignItems:"center",gap:3,fontSize:10,color: smartToggle ? C.accent : C.muted,cursor:"pointer"}}>
                      <input type="checkbox" checked={smartToggle} onChange={e => setSmartToggle(e.target.checked)} style={{margin:0,cursor:"pointer"}} />
                      智能
                    </label>
                    <input
                      type="number" min={1} max={200}
                      value={batchInput}
                      onChange={e => setBatchInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") submitBatch(); if (e.key === "Escape") cancelBatch(); }}
                      autoFocus
                      disabled={smartToggle}
                      style={{width:50,fontSize:11,padding:"1px 4px",background: smartToggle ? "rgba(100,116,139,.1)" : "rgba(255,255,255,.05)",border: smartToggle ? "1px solid rgba(100,116,139,.3)" : "1px solid rgba(168,85,247,.5)",borderRadius:4,color: smartToggle ? C.muted : C.text,outline:"none",fontFamily:"inherit",cursor: smartToggle ? "not-allowed" : "text"}}
                      placeholder={smartToggle ? "智能模式" : "1-200"}
                    />
                    <button className="res-btn" onClick={submitBatch} disabled={batchSaving} style={{padding:"1px 6px"}}>{batchSaving ? "…" : "✓"}</button>
                    <button className="res-btn" onClick={cancelBatch} style={{padding:"1px 6px",background:"rgba(100,116,139,.2)",color:"var(--ink-tertiary)"}}>✕</button>
                  </div>
                ) : (
                  <button
                    className="res-btn"
                    onClick={() => openBatchEditor("problem", problemResources?.batchSize ?? 50)}
                    title={problemResources?.batchOverride ? `当前固定值 ${problemResources.batchSize},智能模式 ${problemResources.smartMode ? "开" : "关"}` : `智能模式:${problemResources?.smartMode ? "开(按队列公式)" : "关"}`}
                  >⚙ 调整</button>
                )}
                <div className="panel-badge" style={{background: (problemResources?.stuckCount ?? 0) > 0 ? "rgba(239,68,68,.2)" : "rgba(16,185,129,.2)", color: (problemResources?.stuckCount ?? 0) > 0 ? "var(--status-err)" : "#10b981"}}>
                  {problemResources ? `${problemResources.runningCount} 问题处理中` : "加载中…"}
                </div>
              </div>
            </div>
            {editingBatch === "problem" && batchMsg && (
              <div style={{fontSize:11,padding:"4px 8px",marginBottom:8,background: batchMsg.startsWith("已") ? "rgba(16,185,129,.1)" : "rgba(245,158,11,.1)",border:`1px solid ${batchMsg.startsWith("已") ? "rgba(16,185,129,.3)" : "rgba(245,158,11,.3)"}`,borderRadius:4,color: batchMsg.startsWith("已") ? "#10b981" : "var(--status-warn)"}}>
                {batchMsg}
              </div>
            )}
            <div className="res-grid" style={{gridTemplateColumns:"repeat(2,1fr)"}}>
              <div className="res-card">
                <div className="l">处理中</div>
                <div className="v" style={{color:C.secondary}}>{problemResources?.runningCount ?? "-"}</div>
                <div className="s">Problem.SOLVING</div>
              </div>
              <div className={`res-card ${(problemResources?.stuckCount ?? 0) > 0 ? "err" : ""}`}>
                <div className="l">卡住 &gt;30min</div>
                <div className="v" style={{color: (problemResources?.stuckCount ?? 0) > 0 ? C.error : C.success}}>
                  {problemResources?.stuckCount ?? "-"}
                </div>
                <div className="s">需清理</div>
              </div>
              <div className="res-card">
                <div className="l">batch 上限</div>
                <div className="v" style={{color: problemResources?.batchOverride ? C.warning : C.accent}}>{problemResources?.batchSize ?? "-"}</div>
                <div className="s">{problemResources?.smartMode ? "🧠 智能模式" : problemResources?.batchOverride ? `固定 ${problemResources.batchOverride}` : "固定默认"}</div>
              </div>
              <div className="res-card">
                <div className="l">待解决</div>
                <div className="v" style={{color:C.muted}}>{problemResources?.pendingCount ?? "-"}</div>
                <div className="s">OPEN</div>
              </div>
            </div>
            <div className="res-util">
              <div
                className={`res-util-fi ${(problemResources?.utilizationPct ?? 0) > 100 ? "over" : ""}`}
                style={{width: `${Math.min(problemResources?.utilizationPct ?? 0, 100)}%`}}
              />
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted,marginBottom:8}}>
              <span style={{color: (problemResources?.utilizationPct ?? 0) > 100 ? C.error : C.muted, fontWeight: (problemResources?.utilizationPct ?? 0) > 100 ? 700 : 400}}>
                占用率 {Math.min(problemResources?.utilizationPct ?? 0, 100)}%
                {(problemResources?.utilizationPct ?? 0) > 100 && (
                  <span style={{marginLeft:6,fontSize:10,padding:"1px 5px",background:"rgba(239,68,68,0.15)",borderRadius:4}}>
                    ⚠ 超载 {problemResources?.utilizationPct}%
                  </span>
                )}
              </span>
              <span>独立调度·problem-resolver.ts</span>
            </div>
            <div className="res-col-title" style={{marginTop:6}}>
              <span>🟣 处理中</span>
              <span style={{color: C.secondary}}>{problemResources?.solvingProblems.length ?? 0}</span>
            </div>
            <div className="res-scroll">
              {!problemResources || problemResources.solvingProblems.length === 0 ? (
                <div className="res-empty">暂无处理中问题</div>
              ) : (
                problemResources.solvingProblems.map(p => {
                  const stuck = p.runningMs > 30 * 60 * 1000;
                  const mins = (p.runningMs / 60000).toFixed(1);
                  return (
                    <div key={p.problemId} className={`res-row ${stuck ? "stuck" : ""}`}>
                      <div className={`res-pri ${p.severity || "P3"}`}>{p.severity || "P?"}</div>
                      <div className="res-title" title={p.description}>{p.description || "(无描述)"}</div>
                      <div className={`res-meta ${stuck ? "stuck" : ""}`}>{mins}m</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ===== 飞轮事件 已迁移到调度器监控之上 ===== */}{/* ===== 第4行：实时吞吐量 + 每时趋势 ===== */}
        <div className="grid-2">
          {/* 左侧：实时吞吐量 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">⚡ 实时吞吐量（每10分钟）</span>
              <span className="panel-badge">{recentWin?.window ?? "--:--"}</span>
            </div>
            <div className="tp-grid">
              <div className="tp-cell">
                <div className="n" style={{color:C.primary}}>{recentWin?.tasks ?? 0}</div>
                <div className="l">完成任务</div>
              </div>
              <div className="tp-cell">
                <div className="n" style={{color:C.secondary}}>{recentWin?.problems ?? 0}</div>
                <div className="l">解决问题</div>
              </div>
              <div className="tp-cell">
                <div className="n" style={{color:C.warning}}>{recentWin?.flywheel ?? 0}</div>
                <div className="l">飞轮转动</div>
              </div>
            </div>
            {/* 10分钟 timeline - SVG拆线图 */}
            {throughput && throughput.length > 0 && (
              <div style={{marginTop:8}}>
                <div style={{fontSize:11,color:C.muted,marginBottom:6}}>最近2小时趋势</div>
                <svg width="100%" height="70" viewBox="0 0 500 70" style={{overflow:"visible"}}>
                  <defs>
                    <filter id="glow-tasks" x="-20%" y="-20%" width="140%" height="140%">
                      <feGaussianBlur stdDeviation="2" result="blur"/>
                      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                    <filter id="glow-problems" x="-20%" y="-20%" width="140%" height="140%">
                      <feGaussianBlur stdDeviation="2" result="blur"/>
                      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                    <filter id="glow-flywheel" x="-20%" y="-20%" width="140%" height="140%">
                      <feGaussianBlur stdDeviation="2" result="blur"/>
                      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                  </defs>
                  {(() => {
                    const n = throughput.length;
                    const maxV = Math.max(...throughput.map(t => Math.max(t.tasks, t.problems, t.flywheel)), 1);
                    const toX = (i: number) => 20 + (i / (n - 1)) * 460;
                    const toY = (v: number) => 65 - (v / maxV) * 55;
                    const tasksPts = throughput.map((w, i) => `${toX(i)},${toY(w.tasks)}`).join(" ");
                    const problemsPts = throughput.map((w, i) => `${toX(i)},${toY(w.problems)}`).join(" ");
                    const flywheelPts = throughput.map((w, i) => `${toX(i)},${toY(w.flywheel)}`).join(" ");
                    return (
                      <>
                        {/* 任务线 */}
                        <polyline points={tasksPts} fill="none" stroke={C.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-tasks)"/>
                        {throughput.map((w, i) => <circle key={`t-${i}`} cx={toX(i)} cy={toY(w.tasks)} r="3" fill={C.primary}/>)}
                        {/* 问题线 */}
                        <polyline points={problemsPts} fill="none" stroke={C.secondary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-problems)"/>
                        {throughput.map((w, i) => <circle key={`p-${i}`} cx={toX(i)} cy={toY(w.problems)} r="3" fill={C.secondary}/>)}
                        {/* 飞轮线 */}
                        <polyline points={flywheelPts} fill="none" stroke={C.warning} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" filter="url(#glow-flywheel)"/>
                        {throughput.map((w, i) => <circle key={`f-${i}`} cx={toX(i)} cy={toY(w.flywheel)} r="3" fill={C.warning}/>)}
                        {/* X轴标签 */}
                        {throughput.map((w, i) => <text key={`l-${i}`} x={toX(i)} y="70" fontSize="8" fill={C.muted} textAnchor="middle">{w.window}</text>)}
                      </>
                    );
                  })()}
                </svg>
                <div style={{display:"flex",gap:16,fontSize:10,marginTop:4}}>
                  <span style={{color:C.primary}}>■ 任务</span>
                  <span style={{color:C.secondary}}>■ 问题</span>
                  <span style={{color:C.warning}}>■ 飞轮</span>
                </div>
              </div>
            )}
          </div>

          {/* 右侧：每小时完成趋势 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">📈 每时完成趋势（今日）</span>
              <span className="panel-badge">任务 / 问题</span>
            </div>
            <div className="bar-chart">
              {hourlyTrend.map(h => {
                const maxV = Math.max(...hourlyTrend.map(t=>Math.max(t.tasks,t.problems)),1);
                return (
                  <div key={h.hour} className="bar-g">
                    <div className="bar-wrap">
                      <div className="bar tasks" style={{height:`${Math.max((h.tasks/maxV)*90,2)}%`}} title={`任务:${h.tasks}`} />
                      <div className="bar problems" style={{height:`${Math.max((h.problems/maxV)*90,2)}%`}} title={`问题:${h.problems}`} />
                    </div>
                    <div className="bar-lbl">{h.hour}时</div>
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:16,fontSize:10,color:C.muted,marginTop:4}}>
              <span style={{color:C.primary}}>■ 任务</span>
              <span style={{color:C.secondary}}>■ 问题</span>
            </div>
          </div>
        </div>

        {/* ===== 第5行：队列优先级 + 失败原因 + 阻塞原因 ===== */}
        <div className="grid-3">
          {/* 队列优先级饼图 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">📊 队列优先级</span>
              <span className="panel-badge">待处理: {pending}</span>
            </div>
            <PieChart dist={Object.entries(queueMap).map(([k,v])=>({reason:k,count:v}))} total={Object.values(queueMap).reduce((a,b)=>a+b,0)} />
          </div>

          {/* 失败原因饼图 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">❌ 失败原因</span>
              <span className="panel-badge">{failed} 个</span>
            </div>
            <PieChart dist={failedDist ?? []} total={failed}  C={C} />
          </div>

          {/* 阻塞原因饼图 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">⚠️ 阻塞原因</span>
              <span className="panel-badge">{blocked} 个</span>
            </div>
            <PieChart dist={blockedDist ?? []} total={blocked}  C={C} />
          </div>
        </div>

        {/* ===== 第6行：取消原因 + 重试分析 + 废弃原因 ===== */}
        <div className="grid-3">
          {/* 取消原因 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">🚫 取消原因</span>
              <span className="panel-badge">{cancelled} 个</span>
            </div>
            <PieChart dist={cancelledDist ?? []} total={cancelled}  C={C} />
          </div>

          {/* 重试分析 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">🔄 重试分析</span>
              <span className="panel-badge">今日: {retryData?.todayRetries ?? 0} 次</span>
            </div>
            <PieChart dist={retryData?.distribution ?? []} total={retryData?.todayRetries ?? 0}  C={C} />
          </div>

          {/* 废弃问题原因 */}
          <div className="panel">
            <div className="panel-hdr">
              <span className="panel-ttl">⚠️ 废弃问题原因</span>
              <span className="panel-badge">{problemMap["ABANDONED"] ?? 0} 个</span>
            </div>
            <PieChart dist={abandonedDist ?? []} total={problemMap["ABANDONED"] ?? 0}  C={C} />
          </div>
        </div>

        {/* ===== 飞轮事件(已迁移到调度器监控之上) ===== */}
        <div className="sec">🔄 飞轮事件</div>
        <div className="panel" style={{marginBottom:16}}>
          <div className="fw-grid">
            {overview.flywheelStages?.map(s => (
              <div key={s.stage} className="fw-card">
                <div className="nm">{stageName(s.stage)}</div>
                <div className="ct">{s._count}</div>
              </div>
            )) || Array.from({length:5},(_,i)=><div key={i} className="fw-card"><div className="nm">—</div><div className="ct">0</div></div>)}
          </div>
          <div className="fw-scroll">
            {schedulerEvents?.events?.slice(0,12).map((e,i)=>{
              const d=e.data as any;
              const title=d?.title || d?.taskId?.slice(0,12) || d?.problemId?.slice(0,12) || JSON.stringify(d||{}).slice(0,30);
              return (
              <div key={i} className="fw-evt">
                <span className="fw-time">{fmtDT(toBJ(e.timestamp))}</span>
                <span className="fw-stage">{typeName(e.type)}</span>
                <span className="fw-desc">{title}</span>
              </div>
            )}) || <div style={{textAlign:"center",color:C.muted,fontSize:12,padding:8}}>暂无飞轮事件</div>}
          </div>
        </div>

        {/* ===== 第7行：调度器双监控 ===== */}
        <div className="sec">⚡ 调度器监控</div>
        <div className="sched-grid">
          {/* 任务调度器 */}
          <div className="sched-item">
            <div className="sched-hdr">
              <span className="sched-name">📋 任务调度器</span>
              <div className={`sched-dot ${scheduler?.taskScheduler?.isActive ? "running" : "idle"}`} />
            </div>
            <div className="sched-time">
              最后运行: {scheduler?.taskScheduler?.lastRun ? fmtDT(toBJ(scheduler.taskScheduler.lastRun)) : "从未"}
            </div>
            <div className="sched-log" ref={taskLogRef}>
              {taskEvents.slice(0,20).map((e,i)=>(
                <div key={i} className="sched-line">
                  <span className="log-time">{new Date(e.timestamp).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Shanghai"})}</span>
                  <span className={`log-tag ${e.type.includes("COMPLETE")?"SUCCESS":e.type.includes("FAILED")?"ERROR":"TASK"}`}>{typeName(e.type)}</span>
                  <span className="log-ct">{(e.data as any)?.title || (e.data as any)?.taskId?.slice(0,12) || `(${Object.keys(e.data||{}).slice(0,2).join(",")})`}</span>
                </div>
              ))}
              {taskEvents.length===0 && <div style={{color:C.muted}}>等待任务事件...</div>}
            </div>
          </div>

          {/* 问题调度器 */}
          <div className="sched-item">
            <div className="sched-hdr">
              <span className="sched-name">⚠️ 问题调度器</span>
              <div className={`sched-dot ${scheduler?.problemScheduler?.isActive ? "running" : "idle"}`} />
            </div>
            <div className="sched-time">
              最后运行: {scheduler?.problemScheduler?.lastRun ? fmtDT(toBJ(scheduler.problemScheduler.lastRun)) : "从未"}
            </div>
            <div className="sched-log" ref={problemLogRef}>
              {problemEvents.slice(0,20).map((e,i)=>(
                <div key={i} className="sched-line">
                  <span className="log-time">{new Date(e.timestamp).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Shanghai"})}</span>
                  <span className={`log-tag ${e.type.includes("SOLVED")?"SUCCESS":e.type.includes("FAILED")?"ERROR":"PROBLEM"}`}>{typeName(e.type)}</span>
                  <span className="log-ct">{(e.data as any)?.title || (e.data as any)?.problemId?.slice(0,12) || `(${Object.keys(e.data||{}).slice(0,2).join(",")})`}</span>
                </div>
              ))}
              {problemEvents.length===0 && <div style={{color:C.muted}}>等待问题事件...</div>}
            </div>
          </div>
        </div>
      </div>

      {/* 右下角: WebSocket 连接状态指示灯 */}
      <WsStatusBadge status={wsStatus} />
    </>
  );
}

// ============ WS 状态指示灯 ============
// 绿=已连接 / 黄=重连中 / 灰=断开
function WsStatusBadge({ status }: { status: WsStatus }) {
  const config: Record<WsStatus, { color: string; bg: string; border: string; text: string; pulse: boolean }> = {
    open:        { color: "#10b981", bg: "rgba(16,185,129,.12)", border: "rgba(16,185,129,.5)",  text: "WS 已连接",   pulse: true  },
    connecting:  { color: "var(--status-warn)", bg: "rgba(245,158,11,.12)", border: "rgba(245,158,11,.5)",  text: "WS 连接中…", pulse: true  },
    reconnecting:{ color: "var(--status-warn)", bg: "rgba(245,158,11,.12)", border: "rgba(245,158,11,.5)",  text: "WS 重连中…", pulse: true  },
    closed:      { color: "var(--ink-tertiary)", bg: "rgba(100,116,139,.12)", border: "rgba(100,116,139,.5)",text: "WS 已断开 · 已降级轮询", pulse: false },
  };
  const c = config[status];
  return (
    <div
      data-testid="ws-status-badge"
      data-ws-status={status}
      style={{
        position: "fixed", right: 16, bottom: 16, zIndex: 9999,
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 12px", borderRadius: 999,
        background: c.bg, border: `1px solid ${c.border}`,
        color: c.color, fontSize: 11, fontFamily: "monospace",
        backdropFilter: "blur(8px)",
        boxShadow: `0 2px 8px rgba(0,0,0,.3)${c.pulse ? `, 0 0 12px ${c.color}55` : ""}`,
        userSelect: "none", cursor: "default",
      }}
      title={`WebSocket: ${status} · ws://localhost:3003`}
    >
      <span
        style={{
          display: "inline-block", width: 8, height: 8, borderRadius: "50%",
          background: c.color,
          boxShadow: c.pulse ? `0 0 6px ${c.color}, 0 0 12px ${c.color}88` : `0 0 4px ${c.color}`,
          animation: c.pulse ? "wsPulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ fontWeight: 600 }}>{c.text}</span>
      <style dangerouslySetInnerHTML={{ __html: `@keyframes wsPulse { 0%,100%{opacity:1} 50%{opacity:.35} }` }} />
    </div>
  );
}