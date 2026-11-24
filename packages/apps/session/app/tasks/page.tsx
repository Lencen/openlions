import { getAllTasks } from "@/lib/tasks-source";
import Topbar from "../components/Topbar";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TRIGGER_LABELS: Record<string, string> = {
  "crontab": "系统 crontab",
  "openclaw-jobs": "OpenClaw jobs.json",
  "service-cron": "服务内 node-cron",
  "script": "业务脚本",
};

const PLATFORM_BADGE: Record<string, string> = {
  hermes: "#7c3aed",
  openclaw: "#d97706",
  dsh: "#2563eb",
  node: "#0d9488",
  shell: "#64748b",
};

const TYPE_LABEL: Record<string, string> = {
  cron: "Cron 表达式",
  interval: "固定间隔",
  manual: "手动触发",
};

export default function TasksPage({
  searchParams,
}: {
  searchParams: { trigger?: string; business?: string; platform?: string; q?: string };
}) {
  const all = getAllTasks();
  // 过滤
  let tasks = all;
  if (searchParams.trigger) tasks = tasks.filter((t) => t.trigger === searchParams.trigger);
  if (searchParams.business) tasks = tasks.filter((t) => t.business === searchParams.business);
  if (searchParams.platform) tasks = tasks.filter((t) => t.agentPlatform === searchParams.platform);
  if (searchParams.q) {
    const q = searchParams.q.toLowerCase();
    tasks = tasks.filter((t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.command.toLowerCase().includes(q) ||
      t.business.toLowerCase().includes(q) ||
      t.agent.toLowerCase().includes(q),
    );
  }

  // filter chips 计数
  const byTrigger = new Map<string, number>();
  const byBusiness = new Map<string, number>();
  const byPlatform = new Map<string, number>();
  for (const t of all) {
    byTrigger.set(t.trigger, (byTrigger.get(t.trigger) || 0) + 1);
    byBusiness.set(t.business, (byBusiness.get(t.business) || 0) + 1);
    byPlatform.set(t.agentPlatform, (byPlatform.get(t.agentPlatform) || 0) + 1);
  }

  function link(extra: Record<string, string | null>) {
    const sp = new URLSearchParams();
    if (searchParams.q) sp.set("q", searchParams.q);
    if (searchParams.trigger) sp.set("trigger", searchParams.trigger);
    if (searchParams.business) sp.set("business", searchParams.business);
    if (searchParams.platform) sp.set("platform", searchParams.platform);
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) sp.delete(k); else sp.set(k, v);
    }
    return `/tasks?${sp.toString()}`;
  }

  // 0.6.5 U-39b M1（设计稿 a678f61fd §2.4）：/tasks = 4 KPI + 保留现有表格
  //   设计原则「已有可用的表格不要重写，只在上面加 KPI 条」-> 表格一行未改
  const kpiCrontab = byTrigger.get("crontab") || 0;
  const kpiNodeCron = byTrigger.get("service-cron") || 0;
  // 「下次执行」：任务数据无 nextRun 字段 -> na + 原因（不猜、不写假值）
  // 0.6.5 四态：服务端组件无 loading 过程，phase = ok / empty（+ ?state= 复现 empty/error）
  const forced = String((searchParams as any).state || "");
  const phase = forced === "empty" ? "empty" : forced === "error" ? "error" : all.length ? "ok" : "empty";

  return (
    <>
      <Topbar active="tasks" stats={`${tasks.length} / ${all.length} tasks`} />
      <main className="page page-wide" data-phase={phase}>
        <div className="list-header" data-slot="page-head">
          <div className="left">
            <h1>定时任务</h1>
            <div className="subtitle">{all.length} 个任务, 按业务来源 / 触发方式 / Agent 平台 多维筛选</div>
          </div>
          <div className="right">
            <form method="get">
              {searchParams.trigger && <input type="hidden" name="trigger" value={searchParams.trigger} />}
              {searchParams.business && <input type="hidden" name="business" value={searchParams.business} />}
              {searchParams.platform && <input type="hidden" name="platform" value={searchParams.platform} />}
              <div className="filter-bar" style={{ margin: 0 }}>
                <div className="search">
                  <input type="text" name="q" defaultValue={searchParams.q || ""} placeholder="搜索任务名/描述/命令..." />
                </div>
              </div>
            </form>
          </div>
        </div>

        {/* 0.6.5 U-39b M1：4 KPI 条（bento-cell 4 个；表格在下方不动） */}
        {phase === "ok" ? (
          <div className="kpi-strip" data-slot="kpi-tasks">
            <div className="kpi-card bento-cell" data-kpi="total" data-cell="task-total">
              <div className="kpi-k">任务总数</div>
              <div className="kpi-v">{all.length}</div>
              <div className="kpi-d">全部已注册任务</div>
            </div>
            <div className="kpi-card bento-cell" data-kpi="crontab" data-cell="task-crontab">
              <div className="kpi-k">系统 crontab</div>
              <div className="kpi-v">{kpiCrontab}</div>
              <div className="kpi-d">由 crontab 触发</div>
            </div>
            <div className="kpi-card bento-cell" data-kpi="nodecron" data-cell="task-nodecron">
              <div className="kpi-k">服务内 node-cron</div>
              <div className="kpi-v">{kpiNodeCron}</div>
              <div className="kpi-d">由服务内定时器触发</div>
            </div>
            <div className="kpi-card bento-cell" data-kpi="next" data-cell="task-next-run">
              <div className="kpi-k">下次执行</div>
              <div className="kpi-v na">n/a</div>
              <div className="kpi-d">原因：任务数据无下次执行时刻字段（不猜）</div>
            </div>
          </div>
        ) : phase === "empty" ? (
          <div className="state-block">
            <b>暂无定时任务</b>
            <p>任务源正常读取但当前没有任何任务（empty，非不可得、非加载中）。{forced ? " · 复现模式：" + forced : ""}</p>
          </div>
        ) : (
          <div className="state-block">
            <b>任务读取失败</b>
            <p>任务源不可读（error，非空集）。{forced ? " · 复现模式：" + forced : ""}</p>
          </div>
        )}

        <div className="filter-section" data-slot="business-filter">
          <div className="filter-label">业务来源</div>
          <div className="chips">
            <Link href={link({ business: null })} className={`chip ${!searchParams.business ? "active" : ""}`}>All <span className="n">{all.length}</span></Link>
            {Array.from(byBusiness.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <Link key={k} href={link({ business: k })} className={`chip ${searchParams.business === k ? "active" : ""}`}>
                {k} <span className="n">{v}</span>
              </Link>
            ))}
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-label">触发方式</div>
          <div className="chips">
            <Link href={link({ trigger: null })} className={`chip ${!searchParams.trigger ? "active" : ""}`}>All <span className="n">{all.length}</span></Link>
            {Array.from(byTrigger.entries()).map(([k, v]) => (
              <Link key={k} href={link({ trigger: k })} className={`chip ${searchParams.trigger === k ? "active" : ""}`}>
                {TRIGGER_LABELS[k] || k} <span className="n">{v}</span>
              </Link>
            ))}
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-label">Agent 平台</div>
          <div className="chips">
            <Link href={link({ platform: null })} className={`chip ${!searchParams.platform ? "active" : ""}`}>All <span className="n">{all.length}</span></Link>
            {Array.from(byPlatform.entries()).map(([k, v]) => (
              <Link key={k} href={link({ platform: k })} className={`chip ${searchParams.platform === k ? "active" : ""}`}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: PLATFORM_BADGE[k] || "#999", marginRight: 6, verticalAlign: "middle" }} />
                {k} <span className="n">{v}</span>
              </Link>
            ))}
          </div>
        </div>

        {phase === "ok" ? (
        <div className="table-wrap" data-table-rows={tasks.length} data-slot="task-table">
          <table className="session-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>业务来源</th>
                <th>触发方式</th>
                <th>周期</th>
                <th>Agent</th>
                <th>平台</th>
                <th>描述</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 ? (
                <tr data-empty-row="true"><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "var(--ink-muted)" }}>没有匹配的任务</td></tr>
              ) : (
                tasks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/tasks/${encodeURIComponent(t.id)}`} className="title">{t.name}</Link>
                      {!t.enabled && <span className="badge badge-red" style={{ marginLeft: 6 }}>disabled</span>}
                    </td>
                    <td className="nowrap">
                      <span className="badge">{t.business}</span>
                    </td>
                    <td className="nowrap">
                      <span className="badge">{TRIGGER_LABELS[t.trigger] || t.trigger}</span>
                    </td>
                    <td className="nowrap"><code style={{ fontSize: 11 }}>{t.schedule}</code></td>
                    <td className="nowrap">{t.agent}</td>
                    <td className="nowrap">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: PLATFORM_BADGE[t.agentPlatform] || "#999" }} />
                        {t.agentPlatform}
                      </span>
                    </td>
                    <td style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.description}>{t.description || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        ) : null}
      </main>
    </>
  );
}
