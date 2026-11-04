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

  return (
    <>
      <Topbar active="tasks" stats={`${tasks.length} / ${all.length} tasks`} />
      <main className="page page-wide">
        <div className="list-header">
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

        <div className="filter-section">
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

        <div className="table-wrap">
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
                <tr><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "var(--ink-muted)" }}>没有匹配的任务</td></tr>
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
      </main>
    </>
  );
}
