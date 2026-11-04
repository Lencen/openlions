"use client";

export const dynamic = "force-dynamic";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useWebSocket, type WsStatus } from "@/lib/ws-client";
import { THEMES, THEME_STORAGE_KEY, type Theme, type ThemeMode, type ResolvedTheme } from "@/lib/theme";

/**
 * LIONS 健康面板
 *
 * 视角: SRE / 运维医生
 * 维度(10):
 *   1. 总体健康度(红/黄/绿) + 服务在线 + 告警汇总
 *   2. 服务心跳(Mind 3000 + Task 3001)
 *   3. 数据库状态(两 DB 大小/最后写入)
 *   4. 资源占用(本进程 RSS/Heap/CPU/uptime)
 *   5. 飞轮状态(spinning/slow/idle/stalled)
 *   6. 反思引擎(active/slow/idle/never)
 *   7. 任务引擎(pending/running/stuck/blocked)
 *   8. 问题引擎(open/solving/solved/abandoned)
 *   9. 告警工单(critical/warning/info)
 *  10. 飞轮时间线(最近 50 条)
 */

// === 类型定义 ===
interface HealthReport {
  timestamp: string;
  overall: "good" | "warn" | "bad";
  summary: { servicesUp: number; servicesTotal: number; alertsCritical: number; alertsWarning: number; alertsInfo: number };
  services: { mind: ServiceInfo; task: ServiceInfo };
  databases: { mind: DbInfo; task: DbInfo };
  resources: { rss: string; heapUsed: string; heapTotal: string; external: string; cpuUserMs: number; cpuSystemMs: number; uptimeSec: number };
  flywheel: { state: string; lastEventAt: string | null; lastEventStage: string | null; lastEventTitle: string | null; idleMin: number; idleLabel: string; events24h: number; events1h: number; byStage24h: Record<string, number> };
  reflection: { state: string; events24h: number; events1h: number; lastAt: string | null; lastTitle: string | null; idleMin: number; idleLabel: string };
  taskEngine: { pending: number; running: number; stuck: number; blocked: number; failed: number; completed: number; cancelled: number; state: string };
  problemEngine: { open: number; solving: number; solved: number; abandoned: number; state: string };
  alerts: Array<{ level: "critical" | "warning" | "info"; category: string; title: string; detail: string; action?: string }>;
  config: { system: any; runtime: any };
  scheduler: { taskLastEvent: string | null; taskLastEventStage: string | null; mindLastEvent: string | null };
}
interface ServiceInfo { url: string; up: boolean; latencyMs: number; error?: string; state: string }
interface DbInfo { exists: boolean; sizeBytes: number; mtime?: string; ageMinutes?: number; size: string; age: string }
interface TimelineEvent { id: string; stage: string; sourceType: string; sourceTitle: string | null; createdAt: string; idleMin: number }

// === 颜色 token(沿用 dashboard 风格:深色 + 青/紫) ===
// === 主题色板(亮 / 暗 双主题) ===
// 设计: 暗色保持原风格;亮色用白底+蓝/紫 accent,Apple/Linear clean 感
function loadTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;
  // 跟随系统
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

// STATE_COLOR 在组件内根据当前主题计算(因为它依赖 C)
function getStateColors(C: Theme): Record<string, string> {
  return {
    // 服务
    online: C.success, offline: C.error,
    // 飞轮
    spinning: C.success, slow: C.warning, idle: C.warning, stalled: C.error,
    // 反思
    active: C.success, never: C.muted,
    // 引擎
    running: C.success, idle_e: C.muted,
  };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function statusDot(state: string, color: string, pulse: boolean = false): JSX.Element {
  return (
    <span style={{
      display: "inline-block", width: 10, height: 10, borderRadius: "50%",
      background: color, marginRight: 6,
      boxShadow: pulse ? `0 0 8px ${color}, 0 0 16px ${color}` : `0 0 4px ${color}`,
      animation: pulse ? "pulse 1.5s ease-in-out infinite" : "none",
    }} />
  );
}

export default function HealthPage() {
  const queryClient = useQueryClient();
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  // 主题(亮/暗/跟随系统) — 默认 dark,客户端 mount 后从 localStorage 读
  const [themeMode, setThemeMode] = useState<"dark" | "light" | "system">("dark");
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    // 优先 URL ?theme=dark|light|system(便于截图)
    const urlTheme = new URLSearchParams(window.location.search).get("theme");
    if (urlTheme === "dark" || urlTheme === "light" || urlTheme === "system") {
      setThemeMode(urlTheme);
      localStorage.setItem(THEME_STORAGE_KEY, urlTheme);
      return;
    }
    const initial = (localStorage.getItem(THEME_STORAGE_KEY) as "dark" | "light" | null) || "system";
    setThemeMode(initial);
  }, []);
  useEffect(() => {
    if (themeMode === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      setResolvedTheme(mq.matches ? "light" : "dark");
      const h = () => setResolvedTheme(mq.matches ? "light" : "dark");
      mq.addEventListener("change", h);
      return () => mq.removeEventListener("change", h);
    } else {
      setResolvedTheme(themeMode);
    }
  }, [themeMode]);
  const setTheme = (m: "dark" | "light" | "system") => {
    setThemeMode(m);
    localStorage.setItem(THEME_STORAGE_KEY, m);
  };
  const C = THEMES[resolvedTheme];
  const STATE_COLOR = getStateColors(C);
  // 卡死清理状态
  const [cleanupThreshold, setCleanupThreshold] = useState<number>(30);
  const [cleanupMsg, setCleanupMsg] = useState<string>("");
  const cleanupMutation = useMutation({
    mutationFn: (vars: { thresholdMin: number; dryRun: boolean }) =>
      fetch("/api/trpc/dashboard.cleanupStuck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: vars }),
      }).then(r => r.json()).then(r => r.result.data),
    onSuccess: (data: any) => {
      setCleanupMsg(data.message || `已清理 ${data.cleaned || 0} 个`);
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["health"] }), 500);
      setTimeout(() => setCleanupMsg(""), 4000);
    },
    onError: (e: any) => setCleanupMsg(`失败: ${e?.message || e}`),
  });
  // flywheel events 用本地 state 做 append-only (绕过 refetch)
  const [wsTimeline, setWsTimeline] = useState<TimelineEvent[] | null>(null);

  const { data: report, refetch, isLoading } = useQuery<HealthReport>({
    queryKey: ["health", "report"],
    queryFn: () => fetch("/api/trpc/health.report").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 3000,  // 一直 3s 轮询(WS 用 setQueryData 覆盖;WS 断时不掉数据)
    refetchIntervalInBackground: false,
    staleTime: 1000,         // WS 1s 推一次,stale 1s 让 setQueryData 总是被视为新数据
  });
  const { data: timeline } = useQuery<TimelineEvent[]>({
    queryKey: ["health", "timeline"],
    queryFn: () => fetch("/api/trpc/health.timeline?input=%7B%22json%22%3A%7B%22limit%22%3A50%7D%7D").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });

  // DLQ KPI: 死信队列堆积 (§18.7 SLO 'DLQ 堆积 < 100')
  const { data: dlqStats } = useQuery<{
    open_total: number; total_24h: number;
    by_source: Array<{ source: string; status: string; count: number }>;
    slo: { level: "ok" | "warning" | "critical"; threshold_warning: number; threshold_critical: number; target: string };
  }>({
    queryKey: ["health", "dlq-stats"],
    queryFn: () => fetch("/api/trpc/dlq.stats").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });

  // 飞轮成功率 KPI (§18.7 SLO '飞轮成功率 ≥95%', 公式 A: done/total)
  const { data: flywheelStats } = useQuery<{
    bridge: { total: number; last24h: number };
    fill: { total: number; last24h: number; routed: Record<string, number> };
    backlog: { pendingSessions: number; pendingReflections: number; openTasks: number };
    taskStats: {
      done: number; failed: number; total: number;
      successRate: number; failureRate: number;
      slo: { level: "ok" | "warning" | "critical"; threshold_target: number; threshold_warning: number; threshold_critical: number; target: string };
    };
  }>({
    queryKey: ["health", "flywheel-throughput"],
    queryFn: () => fetch("/api/trpc/flywheel.getP0Throughput").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });

  // Session 同步延迟 KPI (§18.7 SLO 'Session 同步 <60s', 公式: uploaded_at - last_message_at)
  const { data: syncLagStats } = useQuery<{
    window: string;
    total_24h: number; valid_n: number; outlier_24h: number;
    p50_lag_s: number; p99_lag_s: number; max_lag_s: number;
    slo: { level: "ok" | "warning" | "critical"; threshold_target_s: number; threshold_warning_s: number; threshold_critical_s: number; target: string };
    formula: string;
  }>({
    queryKey: ["health", "sync-lag"],
    queryFn: () => fetch("/api/trpc/sessionRegistry.syncLagStats").then(r => r.json()).then(r => r.result.data),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });

  // 实际渲染用 wsTimeline (有 WS 推送时优先) 或 轮询结果
  const finalTimeline = wsTimeline ?? timeline ?? [];

  // 订阅 ws-server 3003: health:report (1s) + flywheel:event (append)
  useWebSocket(
    typeof window !== "undefined" ? `ws://${window.location.hostname}:3003` : "ws://localhost:3003",
    {
      channels: ["health:report", "flywheel:event"],
      onStatusChange: setWsStatus,
      onMessage: (frame) => {
        if (frame.channel === "health:report" && frame.data) {
          // 防御:只 set 完整对象(services/databases/resources/timeline 必须有)
          const d = frame.data as any;
          if (d?.services?.mind && d?.services?.task && d?.databases && d?.resources && d?.taskEngine && d?.problemEngine && d?.alerts) {
            queryClient.setQueryData(["health", "report"], frame.data);
          } else {
            console.warn("[health] WS 推送数据不完整,忽略:", Object.keys(d || {}));
          }
        } else if (frame.channel === "flywheel:event" && frame.data) {
          // 跨进程事件: 把 event-bus 的 BusEvent 转成 TimelineEvent 形状, prepend 到本地
          const e = frame.data as any;
          const id = e.id || `${e.timestamp}-${Math.random().toString(36).slice(2,8)}`;
          const stage = e.type || "EVENT";
          const sourceTitle = e.payload?.title || e.payload?.taskId?.slice(0,12) || e.payload?.problemId?.slice(0,12) || null;
          const createdAt = typeof e.timestamp === "number" ? new Date(e.timestamp).toISOString() : (e.timestamp || new Date().toISOString());
          const idleMin = Math.round((Date.now() - new Date(createdAt).getTime()) / 60000);
          const newEvt: TimelineEvent = { id, stage, sourceType: e.actor || "bus", sourceTitle, createdAt, idleMin };
          setWsTimeline((prev) => {
            const base = prev ?? timeline ?? [];
            // 去重 by id
            if (base.some(x => x.id === id)) return base;
            return [newEvt, ...base].slice(0, 50);
          });
        }
      },
    }
  );
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  if (isLoading || !report) {
    return <div style={{ padding: 40, color: C.muted, textAlign: "center", fontFamily: "system-ui" }}>
      <div style={{ fontSize: 14 }}>⏳ 正在采集健康数据...</div>
    </div>;
  }

  const overallColor = report.overall === "good" ? C.success : report.overall === "warn" ? C.warning : C.error;
  const overallText = report.overall === "good" ? "全部正常" : report.overall === "warn" ? "需要关注" : "严重告警";

  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui",
      backgroundImage: C.bgGradient,
      transition: "background-color .3s, color .3s",
    }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes scan { 0%{background-position:0 0} 100%{background-position:0 100px} }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        .health-card { background: linear-gradient(135deg, ${C.surface} 0%, ${C.surface2} 100%); border: 1px solid ${C.border}; border-radius: 12px; padding: 18px; transition: all .2s; position: relative; overflow: hidden; }
        .health-card:hover { border-color: ${C.borderHi}; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,212,255,.1); }
        .health-card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; background:linear-gradient(90deg,transparent,${C.primary},transparent); opacity:.5; }
        .health-title { font-size: 12px; color: ${C.dim}; margin-bottom: 8px; font-weight: 600; letter-spacing: 0.5px; }
        .alert-row { padding: 12px 16px; border-left: 3px solid; background: ${C.alertBg}; border-radius: 0 8px 8px 0; margin-bottom: 8px; }
        .timeline-row { display:grid; grid-template-columns: 140px 130px 1fr 100px; gap:12px; padding:8px 12px; font-size:12px; border-bottom:1px solid ${resolvedTheme === "dark" ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.06)"}; font-family:'SF Mono',Consolas,monospace; }
        .timeline-row:hover { background: ${C.rowHover}; }
      ` }} />

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "20px 24px 40px" }}>

        {/* ===== 页面标题 + 面包屑 ===== */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <a href="/dashboard" style={{
              fontSize: 12, color: C.muted, textDecoration: "none", padding: "4px 10px",
              border: `1px solid ${C.border}`, borderRadius: 6, background: "rgba(0,0,0,.2)",
              display: "flex", alignItems: "center", gap: 4, transition: "all .2s",
            }}>
              ← Dashboard
            </a>
            <div>
              <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, textTransform: "uppercase", marginBottom: 2 }}>LIONS Operations Console</div>
              <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: C.text, display: "flex", alignItems: "center", gap: 10 }}>
                🩺 系统健康面板
                <span style={{ fontSize: 11, color: C.muted, fontWeight: 400, padding: "2px 8px", background: "rgba(0,212,255,.08)", border: `1px solid ${C.border}`, borderRadius: 10, fontFamily: "monospace" }}>
                  /health
                </span>
              </h1>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: C.muted }}>
            {/* 主题切换器(暗 / 亮 / 跟随系统) */}
            <div style={{ display: "flex", alignItems: "center", background: C.cfgBg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 2, gap: 1 }}>
              {([["dark","🌙"],["light","☀️"],["system","⚙"]] as const).map(([k, icon]) => (
                <button
                  key={k}
                  onClick={() => setTheme(k)}
                  title={k === "dark" ? "暗色主题" : k === "light" ? "明亮主题" : "跟随系统"}
                  style={{
                    background: themeMode === k ? `${C.primary}22` : "transparent",
                    color: themeMode === k ? C.primary : C.muted,
                    border: "none", borderRadius: 4, padding: "3px 8px",
                    fontSize: 12, cursor: "pointer", lineHeight: 1,
                  }}
                >{icon}</button>
              ))}
            </div>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span data-testid="ws-health-dot" style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: wsStatus === "open" ? C.success : wsStatus === "closed" ? C.error : C.warning,
                boxShadow: `0 0 6px ${wsStatus === "open" ? C.success : wsStatus === "closed" ? C.error : C.warning}`,
                animation: wsStatus !== "closed" ? "pulse 1.5s infinite" : "none",
              }} />
              实时同步 · {wsStatus === "open" ? "WS 推送 1s" : wsStatus === "closed" ? "已降级轮询 5s" : "WS " + wsStatus}
            </span>
            <button
              onClick={() => { refetch(); }}
              style={{ background: `${C.primary}11`, border: `1px solid ${C.primary}55`, color: C.primary, padding: "4px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer" }}
            >↻ 刷新</button>
          </div>
        </div>

        {/* ===== 顶部:总体健康度 ===== */}
        <div style={{
          background: `linear-gradient(135deg, ${overallColor}22 0%, transparent 100%)`,
          border: `1px solid ${overallColor}55`, borderRadius: 14, padding: "20px 28px",
          display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20,
          position: "relative", overflow: "hidden",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {statusDot(report.overall, overallColor, report.overall === "bad")}
            <div>
              <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, textTransform: "uppercase" }}>🩺 LIONS Health Status</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: overallColor, marginTop: 2 }}>
                {overallText}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
            <Stat label="服务在线" value={`${report.summary.servicesUp}/${report.summary.servicesTotal}`} color={report.summary.servicesUp === 2 ? C.success : C.warning}  C={C}/>
            <Stat label="严重告警" value={String(report.summary.alertsCritical)} color={report.summary.alertsCritical > 0 ? C.error : C.muted} C={C} />
            <Stat label="普通告警" value={String(report.summary.alertsWarning)} color={report.summary.alertsWarning > 0 ? C.warning : C.muted} C={C} />
            <Stat label="提示" value={String(report.summary.alertsInfo)} color={C.dim}  C={C}/>
            <Stat label="本机时间" value={now.toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })} color={C.primary} mono  C={C}/>
          </div>
        </div>

        {/* ===== 6 个核心健康卡片 ===== */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>

          {/* 1. 服务心跳 */}
          <div className="health-card">
            <div className="health-title">💓 服务心跳</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <ServiceRow name="Lions-Mind" port={3000} info={report.services.mind} C={C} STATE_COLOR={STATE_COLOR} />
              <ServiceRow name="Selfimproving-Task" port={3001} info={report.services.task} C={C} STATE_COLOR={STATE_COLOR} />
            </div>
          </div>

          {/* 2. 数据库 */}
          <div className="health-card">
            <div className="health-title">🗄 数据库状态</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <DbRow label="Lions-Mind DB" db={report.databases.mind}  C={C}/>
              <DbRow label="Task DB" db={report.databases.task}  C={C}/>
            </div>
          </div>

          {/* 3. 资源占用 */}
          <div className="health-card">
            <div className="health-title">💪 资源占用 (本进程 3001)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <ResourceBar label="RSS" value={report.resources.rss} pct={Math.min(parseInt(report.resources.rss) / 10, 100)}  C={C}/>
              <ResourceBar label="Heap 已用" value={report.resources.heapUsed} pct={parseInt(report.resources.heapUsed) / parseInt(report.resources.heapTotal) * 100}  C={C}/>
              <ResourceBar label="External" value={report.resources.external} pct={20}  C={C}/>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: C.muted }}>
                <span>CPU 用户/系统: <span style={{ color: C.dim, fontFamily: "monospace" }}>{report.resources.cpuUserMs}/{report.resources.cpuSystemMs} ms</span></span>
                <span>运行时长: <span style={{ color: C.dim, fontFamily: "monospace" }}>{fmtUptime(report.resources.uptimeSec)}</span></span>
              </div>
            </div>
          </div>

          {/* 4. 飞轮状态 */}
          <div className="health-card">
            <div className="health-title">🔄 飞轮状态</div>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              {statusDot(report.flywheel.state, STATE_COLOR[report.flywheel.state] || C.muted, report.flywheel.state === "spinning")}
              <span style={{ fontSize: 18, fontWeight: 700, color: STATE_COLOR[report.flywheel.state] || C.muted, textTransform: "uppercase", letterSpacing: 1 }}>
                {report.flywheel.state}
              </span>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>最后事件</div>
            <div style={{ fontSize: 13, color: C.text, fontFamily: "monospace", marginBottom: 8 }}>
              {report.flywheel.idleLabel} · {report.flywheel.lastEventStage || "—"}
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
              <span>1h: <span style={{ color: C.primary, fontFamily: "monospace" }}>{report.flywheel.events1h}</span></span>
              <span>24h: <span style={{ color: C.primary, fontFamily: "monospace" }}>{report.flywheel.events24h}</span></span>
            </div>
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {Object.entries(report.flywheel.byStage24h).slice(0, 5).map(([k, v]) => (
                <span key={k} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 8, background: "rgba(168,85,247,.15)", color: C.accent, fontFamily: "monospace" }}>
                  {k}:{v}
                </span>
              ))}
            </div>
          </div>

          {/* 5. 反思引擎 */}
          <div className="health-card">
            <div className="health-title">🧠 反思引擎</div>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              {statusDot(report.reflection.state, STATE_COLOR[report.reflection.state] || C.muted, report.reflection.state === "active")}
              <span style={{ fontSize: 18, fontWeight: 700, color: STATE_COLOR[report.reflection.state] || C.muted, textTransform: "uppercase", letterSpacing: 1 }}>
                {report.reflection.state}
              </span>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>最后反思</div>
            <div style={{ fontSize: 13, color: C.text, fontFamily: "monospace", marginBottom: 8 }}>
              {report.reflection.idleLabel}
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
              <span>1h: <span style={{ color: C.accent, fontFamily: "monospace" }}>{report.reflection.events1h}</span></span>
              <span>24h: <span style={{ color: C.accent, fontFamily: "monospace" }}>{report.reflection.events24h}</span></span>
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 8, fontStyle: "italic" }}>
              {report.reflection.lastTitle || "(无样本)"}
            </div>
          </div>

          {/* 6. 任务引擎 + 问题引擎 */}
          <div className="health-card">
            <div className="health-title">⚙️ 引擎状态</div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                {statusDot(report.taskEngine.state === "running" ? "running" : "idle_e", report.taskEngine.state === "running" ? C.success : C.muted, report.taskEngine.state === "running")}
                <span style={{ fontSize: 12, color: C.dim, fontWeight: 600 }}>任务引擎</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, fontSize: 11 }}>
                <KPImini label="待处理" value={report.taskEngine.pending} color={C.muted}  C={C}/>
                <KPImini label="运行中" value={report.taskEngine.running} color={C.success}  C={C}/>
                <KPImini label="卡住" value={report.taskEngine.stuck} color={report.taskEngine.stuck > 0 ? C.error : C.muted} C={C} />
                {report.taskEngine.stuck > 0 && (
                  <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 6, marginTop: 4, padding: "4px 6px", background: "rgba(239,68,68,.08)", border: `1px solid rgba(239,68,68,.3)`, borderRadius: 4 }}>
                    <select
                      value={cleanupThreshold}
                      onChange={e => setCleanupThreshold(Number(e.target.value))}
                      style={{ background: "rgba(0,0,0,.4)", color: C.text, border: `1px solid ${C.border}`, borderRadius: 3, fontSize: 10, padding: "1px 4px" }}
                    >
                      <option value={15}>15m+</option>
                      <option value={30}>30m+</option>
                      <option value={60}>1h+</option>
                      <option value={360}>6h+</option>
                    </select>
                    <button
                      onClick={() => cleanupMutation.mutate({ thresholdMin: cleanupThreshold, dryRun: true })}
                      disabled={cleanupMutation.isPending}
                      style={{ background: "transparent", color: C.muted, border: `1px solid ${C.border}`, borderRadius: 3, fontSize: 10, padding: "1px 6px", cursor: "pointer" }}
                    >预览</button>
                    <button
                      onClick={() => {
                        if (confirm(`确认清理 >${cleanupThreshold}分钟的卡死 TaskExecution?`)) {
                          cleanupMutation.mutate({ thresholdMin: cleanupThreshold, dryRun: false });
                        }
                      }}
                      disabled={cleanupMutation.isPending}
                      style={{ background: "rgba(239,68,68,.2)", color: C.error, border: `1px solid rgba(239,68,68,.5)`, borderRadius: 3, fontSize: 10, padding: "1px 6px", cursor: "pointer", fontWeight: 600 }}
                    >{cleanupMutation.isPending ? "清理中..." : "清理"}</button>
                    {cleanupMsg && <span style={{ fontSize: 9, color: C.success, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cleanupMsg}</span>}
                  </div>
                )}
                <KPImini label="阻塞" value={report.taskEngine.blocked} color={C.warning}  C={C}/>
                <KPImini label="失败" value={report.taskEngine.failed} color={C.muted}  C={C}/>
                <KPImini label="完成" value={report.taskEngine.completed} color={C.primary}  C={C}/>
              </div>
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                {statusDot(report.problemEngine.state === "running" ? "running" : "idle_e", report.problemEngine.state === "running" ? C.success : C.muted, report.problemEngine.state === "running")}
                <span style={{ fontSize: 12, color: C.dim, fontWeight: 600 }}>问题引擎</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11 }}>
                <KPImini label="待解决" value={report.problemEngine.open} color={C.muted}  C={C}/>
                <KPImini label="处理中" value={report.problemEngine.solving} color={C.success}  C={C}/>
                <KPImini label="已解决" value={report.problemEngine.solved} color={C.primary}  C={C}/>
                <KPImini label="已废弃" value={report.problemEngine.abandoned} color={C.muted}  C={C}/>
              </div>
            </div>
          </div>
        </div>

        {/* ===== DLQ SLO 卡 (§18.7 死信队列堆积) ===== */}
        <div className="health-card" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div className="health-title" style={{ marginBottom: 0 }}>📮 DLQ 死信队列 (§18.7 SLO)</div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: "monospace" }}>
              {dlqStats ? `target: ${dlqStats.slo.target}` : "loading..."}
            </div>
          </div>
          {dlqStats ? (
            <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 1fr", gap: 16, alignItems: "center" }}>
              {/* 大数字 + 状态色 */}
              <div style={{
                padding: "16px 20px", borderRadius: 10,
                background: dlqStats.slo.level === "critical" ? `${C.error}22` : dlqStats.slo.level === "warning" ? `${C.warning}22` : `${C.success}22`,
                border: `1px solid ${dlqStats.slo.level === "critical" ? C.error : dlqStats.slo.level === "warning" ? C.warning : C.success}55`,
              }}>
                <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1, textTransform: "uppercase" }}>未处理堆积</div>
                <div style={{
                  fontSize: 32, fontWeight: 700, fontFamily: "monospace",
                  color: dlqStats.slo.level === "critical" ? C.error : dlqStats.slo.level === "warning" ? C.warning : C.success,
                  lineHeight: 1.2,
                }}>{dlqStats.open_total}</div>
                <div style={{ fontSize: 10, color: C.dim, fontFamily: "monospace", marginTop: 2 }}>
                  warn:{dlqStats.slo.threshold_warning} / crit:{dlqStats.slo.threshold_critical}
                </div>
              </div>
              {/* 进度条 */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
                  <span>SLO 等级</span>
                  <span style={{
                    color: dlqStats.slo.level === "critical" ? C.error : dlqStats.slo.level === "warning" ? C.warning : C.success,
                    fontFamily: "monospace", fontWeight: 700, textTransform: "uppercase",
                  }}>{dlqStats.slo.level}</span>
                </div>
                <div style={{ height: 8, background: "rgba(255,255,255,.05)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                  <div style={{
                    width: `${Math.min(100, (dlqStats.open_total / dlqStats.slo.threshold_critical) * 100)}%`,
                    height: "100%",
                    background: dlqStats.slo.level === "critical" ? C.error : dlqStats.slo.level === "warning" ? C.warning : C.success,
                    transition: "width .3s",
                  }} />
                  {/* warning 阈值刻度 */}
                  <div style={{
                    position: "absolute", top: 0, bottom: 0,
                    left: `${(dlqStats.slo.threshold_warning / dlqStats.slo.threshold_critical) * 100}%`,
                    width: 1, background: C.warning, opacity: 0.6,
                  }} />
                </div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 6, fontFamily: "monospace" }}>
                  24h 累计: <span style={{ color: C.primary }}>{dlqStats.total_24h}</span>
                </div>
              </div>
              {/* By source 分布 */}
              <div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>按来源分布 (24h)</div>
                {dlqStats.by_source.length === 0 ? (
                  <div style={{ fontSize: 11, color: C.dim, fontStyle: "italic" }}>(无数据)</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {dlqStats.by_source.map((s, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "monospace" }}>
                        <span style={{ color: C.text }}>{s.source}</span>
                        <span style={{ color: s.status === "OPEN" ? C.warning : s.status === "RESOLVED" ? C.success : C.muted }}>
                          {s.status}: {s.count}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ padding: 20, color: C.muted, fontSize: 12, textAlign: "center" }}>正在加载 DLQ 统计...</div>
          )}
        </div>

        {/* ===== 飞轮成功率 SLO 卡 (§18.7 公式 A: done/total) ===== */}
        <div className="health-card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div className="health-title" style={{ marginBottom: 0 }}>🎯 飞轮成功率 (§18.7 SLO)</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              {flywheelStats ? `target: ${flywheelStats.taskStats.slo.target}` : "loading..."}
            </div>
          </div>
          {flywheelStats ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr 1fr", gap: 16 }}>
              {/* 大数字: 成功率 % */}
              <div style={{
                padding: "16px 20px", borderRadius: 8,
                background: flywheelStats.taskStats.slo.level === "critical" ? `${C.error}22` : flywheelStats.taskStats.slo.level === "warning" ? `${C.warning}22` : `${C.success}22`,
                border: `1px solid ${flywheelStats.taskStats.slo.level === "critical" ? C.error : flywheelStats.taskStats.slo.level === "warning" ? C.warning : C.success}55`,
              }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>成功率 (done/total)</div>
                <div style={{
                  fontSize: 36, fontWeight: 700,
                  color: flywheelStats.taskStats.slo.level === "critical" ? C.error : flywheelStats.taskStats.slo.level === "warning" ? C.warning : C.success,
                  lineHeight: 1,
                }}>{flywheelStats.taskStats.successRate}<span style={{ fontSize: 18, marginLeft: 2 }}>%</span></div>
                <div style={{ fontSize: 10, color: C.dim, marginTop: 6 }}>
                  target:{flywheelStats.taskStats.slo.threshold_target}% / warn:&lt;{flywheelStats.taskStats.slo.threshold_warning}% / crit:&lt;{flywheelStats.taskStats.slo.threshold_critical}%
                </div>
              </div>
              {/* 进度条 + done/total + level */}
              <div style={{ padding: "16px 20px", borderRadius: 8, background: C.alertBg, border: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: C.muted }}>SLO 状态</div>
                  <span style={{
                    fontSize: 10, padding: "2px 8px", borderRadius: 4, fontWeight: 700, letterSpacing: 0.5,
                    color: flywheelStats.taskStats.slo.level === "critical" ? C.error : flywheelStats.taskStats.slo.level === "warning" ? C.warning : C.success,
                    background: `${flywheelStats.taskStats.slo.level === "critical" ? C.error : flywheelStats.taskStats.slo.level === "warning" ? C.warning : C.success}22`,
                  }}>{flywheelStats.taskStats.slo.level}</span>
                </div>
                {/* 进度条 (0-100%, target 线在 95%) */}
                <div style={{ position: "relative", height: 8, background: C.border, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                  <div style={{
                    width: `${flywheelStats.taskStats.successRate}%`, height: "100%",
                    background: flywheelStats.taskStats.slo.level === "critical" ? C.error : flywheelStats.taskStats.slo.level === "warning" ? C.warning : C.success,
                    transition: "width 0.3s ease",
                  }} />
                  {/* target 95% 线 */}
                  <div style={{ position: "absolute", top: -2, height: 12, width: 1, left: "95%", background: C.text, opacity: 0.6 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: C.dim }}>
                    完成: <span style={{ color: C.success, fontWeight: 600 }}>{flywheelStats.taskStats.done}</span>
                    <span style={{ color: C.muted }}> / </span>
                    总创建: <span style={{ color: C.text, fontWeight: 600 }}>{flywheelStats.taskStats.total}</span>
                  </span>
                  <span style={{ color: C.dim }}>
                    失败: <span style={{ color: flywheelStats.taskStats.failed > 0 ? C.error : C.muted, fontWeight: 600 }}>{flywheelStats.taskStats.failed}</span>
                  </span>
                </div>
              </div>
              {/* 桥 + 回填 + 积压 mini */}
              <div style={{ padding: "12px 16px", borderRadius: 8, background: C.alertBg, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>飞轮吞吐</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontFamily: "monospace" }}>
                  <div>桥(R→T): <span style={{ color: C.primary, fontWeight: 600 }}>{flywheelStats.bridge.total}</span> <span style={{ color: C.muted, fontSize: 10 }}>(24h:{flywheelStats.bridge.last24h})</span></div>
                  <div>回填(T→F): <span style={{ color: C.primary, fontWeight: 600 }}>{flywheelStats.fill.total}</span> <span style={{ color: C.muted, fontSize: 10 }}>(24h:{flywheelStats.fill.last24h})</span></div>
                  <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 4, marginTop: 2 }}>
                    <div style={{ color: C.dim, fontSize: 10 }}>积压</div>
                    <div>Session: <span style={{ color: flywheelStats.backlog.pendingSessions > 100 ? C.warning : C.text }}>{flywheelStats.backlog.pendingSessions}</span></div>
                    <div>Reflect: <span style={{ color: flywheelStats.backlog.pendingReflections > 100 ? C.warning : C.text }}>{flywheelStats.backlog.pendingReflections}</span></div>
                    <div>OpenTask: <span style={{ color: C.text }}>{flywheelStats.backlog.openTasks}</span></div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 20, color: C.muted, fontSize: 12, textAlign: "center" }}>正在加载飞轮成功率...</div>
          )}
        </div>

        {/* ===== Session 同步延迟 SLO 卡 (§18.7 公式: uploaded_at - last_message_at, 24h 窗口) ===== */}
        <div className="health-card">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <div className="health-title" style={{ marginBottom: 0 }}>⏱ Session 同步延迟 (§18.7 SLO)</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              {syncLagStats ? `target: ${syncLagStats.slo.target} (window: ${syncLagStats.window})` : "loading..."}
            </div>
          </div>
          {syncLagStats ? (
            syncLagStats.valid_n === 0 ? (
              <div style={{ padding: 20, color: C.muted, fontSize: 12, textAlign: "center", background: C.alertBg, borderRadius: 8, border: `1px dashed ${C.border}` }}>
                ⚠ 24h 内无有效 session 上报样本 (total_24h={syncLagStats.total_24h}, outlier={syncLagStats.outlier_24h})
                <div style={{ marginTop: 6, fontSize: 11, color: C.dim }}>说明: 最近 24h 内没有新 session 入库 — 检查 hermes session uploader 是否在跑</div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                {/* p99 主指标 */}
                <div style={{
                  padding: "16px 20px", borderRadius: 8,
                  background: syncLagStats.slo.level === "critical" ? `${C.error}22` : syncLagStats.slo.level === "warning" ? `${C.warning}22` : `${C.success}22`,
                  border: `1px solid ${syncLagStats.slo.level === "critical" ? C.error : syncLagStats.slo.level === "warning" ? C.warning : C.success}55`,
                }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>p99 lag</div>
                  <div style={{
                    fontSize: 32, fontWeight: 700,
                    color: syncLagStats.slo.level === "critical" ? C.error : syncLagStats.slo.level === "warning" ? C.warning : C.success,
                    lineHeight: 1,
                  }}>{syncLagStats.p99_lag_s}<span style={{ fontSize: 18, marginLeft: 2 }}>s</span></div>
                  <div style={{ fontSize: 10, color: C.dim, marginTop: 6 }}>
                    target:&lt;{syncLagStats.slo.threshold_target_s}s / warn:&lt;{syncLagStats.slo.threshold_warning_s}s / crit:&lt;{syncLagStats.slo.threshold_critical_s}s
                  </div>
                </div>
                {/* SLO 进度条 (p99 / critical 阈值) */}
                <div style={{ padding: "12px 16px", borderRadius: 8, background: C.alertBg, border: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11 }}>
                    <span style={{ color: C.muted }}>SLO 级别</span>
                    <span style={{
                      fontSize: 10, padding: "1px 6px", borderRadius: 4, fontWeight: 700,
                      color: syncLagStats.slo.level === "critical" ? C.error : syncLagStats.slo.level === "warning" ? C.warning : C.success,
                      background: `${syncLagStats.slo.level === "critical" ? C.error : syncLagStats.slo.level === "warning" ? C.warning : C.success}22`,
                    }}>{syncLagStats.slo.level}</span>
                  </div>
                  <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: "hidden", position: "relative", marginBottom: 8 }}>
                    <div style={{
                      width: `${Math.min(100, (syncLagStats.p99_lag_s / syncLagStats.slo.threshold_critical_s) * 100)}%`, height: "100%",
                      background: syncLagStats.slo.level === "critical" ? C.error : syncLagStats.slo.level === "warning" ? C.warning : C.success,
                    }} />
                    {/* target 线 (60/300) */}
                    <div style={{ position: "absolute", top: -2, height: 12, width: 1, left: `${(syncLagStats.slo.threshold_target_s / syncLagStats.slo.threshold_critical_s) * 100}%`, background: C.text, opacity: 0.6 }} />
                  </div>
                  <div style={{ fontSize: 10, color: C.dim }}>
                    0s ─ target {syncLagStats.slo.threshold_target_s}s ─ critical {syncLagStats.slo.threshold_critical_s}s
                  </div>
                </div>
                {/* p50 / max / 样本量 */}
                <div style={{ padding: "12px 16px", borderRadius: 8, background: C.alertBg, border: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>样本分布</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontFamily: "monospace" }}>
                    <div>p50: <span style={{ color: C.primary, fontWeight: 600 }}>{syncLagStats.p50_lag_s}s</span></div>
                    <div>max: <span style={{ color: syncLagStats.max_lag_s > syncLagStats.slo.threshold_critical_s ? C.warning : C.text, fontWeight: 600 }}>{syncLagStats.max_lag_s}s</span></div>
                    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 4, marginTop: 2 }}>
                      <div style={{ color: C.dim, fontSize: 10 }}>24h 样本</div>
                      <div>有效: <span style={{ color: C.success, fontWeight: 600 }}>{syncLagStats.valid_n}</span> <span style={{ color: C.muted, fontSize: 10 }}>/ 总 {syncLagStats.total_24h}</span></div>
                      <div>异常: <span style={{ color: syncLagStats.outlier_24h > 0 ? C.warning : C.muted, fontWeight: 600 }}>{syncLagStats.outlier_24h}</span> <span style={{ color: C.muted, fontSize: 10 }}>(过滤)</span></div>
                    </div>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div style={{ padding: 20, color: C.muted, fontSize: 12, textAlign: "center" }}>正在加载 Session 同步延迟...</div>
          )}
        </div>

        {/* ===== 告警工单 + 飞轮时间线(并排两列) ===== */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>

          {/* 告警 */}
          <div className="health-card">
            <div className="health-title">📋 告警工单 ({report.alerts.length})</div>
            {report.alerts.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: C.success, fontSize: 13 }}>
                ✅ 全部正常,无需处理
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {report.alerts.map((a, i) => (
                  <div key={i} className="alert-row" style={{
                    borderLeftColor: a.level === "critical" ? C.error : a.level === "warning" ? C.warning : C.primary,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                      <span style={{
                        fontSize: 9, padding: "1px 6px", borderRadius: 4, marginRight: 8,
                        background: a.level === "critical" ? C.error : a.level === "warning" ? C.warning : C.primary,
                        color: "var(--bg-base)", fontWeight: 700, letterSpacing: 0.5,
                      }}>{a.level.toUpperCase()}</span>
                      <span style={{ fontSize: 10, color: C.muted, marginRight: 6 }}>{a.category}</span>
                      <span style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{a.title}</span>
                    </div>
                    <div style={{ fontSize: 11, color: C.dim, marginLeft: 4, lineHeight: 1.5 }}>{a.detail}</div>
                    {a.action && (
                      <div style={{ fontSize: 11, color: C.accent, marginLeft: 4, marginTop: 4 }}>
                        💡 {a.action}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 运行时配置 */}
            <div style={{ marginTop: 16, padding: 12, background: C.cfgBg, borderRadius: 8, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, letterSpacing: 1 }}>⚙ 运行时配置</div>
              {report.config.runtime && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11, fontFamily: "monospace" }}>
                  <ConfigRow label="任务" smart={report.config.runtime.taskSmartMode} batch={report.config.runtime.taskBatchSize}  C={C}/>
                  <ConfigRow label="问题" smart={report.config.runtime.problemSmartMode} batch={report.config.runtime.problemBatchSize}  C={C}/>
                </div>
              )}
            </div>
          </div>

          {/* 飞轮时间线 */}
          <div className="health-card">
            <div className="health-title">⏱ 飞轮时间线 (最近 50 条)</div>
            <div className="timeline-row" style={{ background: C.alertBg, color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
              <span>时间</span><span>类型</span><span>标题</span><span style={{ textAlign: "right" }}>距今</span>
            </div>
            <div style={{ maxHeight: 380, overflowY: "auto" }}>
              {finalTimeline.map(e => (
                <div key={e.id} className="timeline-row">
                  <span style={{ color: C.dim }}>{fmtTime(e.createdAt).split(" ")[1]}</span>
                  <span style={{ color: stageColor(e.stage, C) }}>{e.stage}</span>
                  <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.sourceTitle || `(${e.sourceType})`}</span>
                  <span style={{ textAlign: "right", color: e.idleMin < 60 ? C.success : e.idleMin < 360 ? C.warning : C.muted }}>{e.idleMin < 1 ? "刚刚" : `${e.idleMin}m`}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* 右下角: WebSocket 状态指示灯 */}
      <HealthWsBadge status={wsStatus}  C={C}/>
    </div>
  );
}

// === 子组件 — WS 状态指示灯 (健康页) ===
function HealthWsBadge({ status, C }: { status: WsStatus; C: Theme }) {
  const cfg: Record<WsStatus, { color: string; bg: string; border: string; text: string; pulse: boolean }> = {
    open:        { color: C.success, bg: "rgba(16,185,129,.12)", border: "rgba(16,185,129,.5)",  text: "WS 已连接 · 1s 推送",   pulse: true  },
    connecting:  { color: C.warning, bg: "rgba(245,158,11,.12)", border: "rgba(245,158,11,.5)",  text: "WS 连接中…",            pulse: true  },
    closed:      { color: C.muted,   bg: "rgba(100,116,139,.12)",border: "rgba(100,116,139,.5)", text: "WS 已断开 · 降级轮询",   pulse: false },
    error:       { color: C.error,   bg: "rgba(239,68,68,.12)",  border: "rgba(239,68,68,.5)",  text: "WS 错误",                  pulse: false },
  };
  const c = cfg[status];
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
        userSelect: "none",
      }}
      title={`WebSocket: ${status} · ws://localhost:3003`}
    >
      <span
        style={{
          display: "inline-block", width: 8, height: 8, borderRadius: "50%",
          background: c.color,
          boxShadow: c.pulse ? `0 0 6px ${c.color}, 0 0 12px ${c.color}88` : `0 0 4px ${c.color}`,
          animation: c.pulse ? "pulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ fontWeight: 600 }}>{c.text}</span>
    </div>
  );
}

// === 子组件 ===
function Stat({ label, value, color, mono, C }: { label: string; value: string; color: string; mono?: boolean; C: Theme }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: mono ? "monospace" : "inherit", marginTop: 2 }}>{value}</div>
    </div>
  );
}

function ServiceRow({ name, port, info, C, STATE_COLOR }: { name: string; port: number; info: ServiceInfo; C: Theme; STATE_COLOR: ReturnType<typeof getStateColors> }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        {statusDot(info.state, STATE_COLOR[info.state] || C.muted, info.up)}
        <div>
          <div style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{name} <span style={{ color: C.muted, fontWeight: 400 }}>:{port}</span></div>
          <div style={{ fontSize: 10, color: C.muted, fontFamily: "monospace" }}>{info.latencyMs}ms · {info.up ? "reachable" : info.error || "unreachable"}</div>
        </div>
      </div>
      <span style={{
        fontSize: 9, padding: "2px 8px", borderRadius: 10,
        background: info.up ? `${C.success}22` : `${C.error}22`,
        color: info.up ? C.success : C.error, fontWeight: 700, letterSpacing: 0.5,
      }}>{info.state.toUpperCase()}</span>
    </div>
  );
}

function DbRow({ label, db, C }: { label: string; db: DbInfo; C: Theme }) {
  const stale = (db.ageMinutes ?? 0) > 60;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 11, color: C.muted, fontFamily: "monospace" }}>{db.size}</span>
      </div>
      <div style={{ fontSize: 10, color: stale ? C.warning : C.muted, marginTop: 2, fontFamily: "monospace" }}>
        最后写入: {db.age} {stale && "⚠️"}
      </div>
    </div>
  );
}

function ResourceBar({ label, value, pct, C }: { label: string; value: string; pct: number; C: Theme }) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const color = clamped > 80 ? C.error : clamped > 60 ? C.warning : C.success;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
        <span style={{ color: C.muted }}>{label}</span>
        <span style={{ color: C.text, fontFamily: "monospace" }}>{value}</span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,.05)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${clamped}%`, height: "100%", background: color, borderRadius: 2, transition: "width .3s" }} />
      </div>
    </div>
  );
}

function KPImini({ label, value, color, C }: { label: string; value: number; color: string; C: Theme }) {
  return (
    <div style={{ background: C.alertBg, padding: "4px 6px", borderRadius: 4 }}>
      <div style={{ fontSize: 9, color: C.muted, letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, color, fontWeight: 700, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

function ConfigRow({ label, smart, batch, C }: { label: string; smart: boolean; batch: number; C: Theme }) {
  return (
    <div>
      <span style={{ color: C.muted }}>{label}: </span>
      <span style={{ color: smart ? C.success : C.warning }}>{smart ? "🧠智能" : "🔒固定"}</span>
      <span style={{ color: C.primary, marginLeft: 4 }}>{batch}</span>
    </div>
  );
}

function stageColor(s: string, C: Theme): string {
  if (s.startsWith("PROBLEM_SOLVED") || s.startsWith("OUTCOME")) return C.success;
  if (s.startsWith("PROBLEM_CREATED") || s.startsWith("TASK")) return C.primary;
  if (s.startsWith("REFLECTION")) return C.accent;
  if (s.startsWith("BULK")) return C.warning;
  return C.dim;
}

