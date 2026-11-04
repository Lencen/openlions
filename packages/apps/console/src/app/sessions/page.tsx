// Phase0.5 路由先行 (2026-09-17): /sessions 会话中心列表页
// 运营反馈: 会话中心路由此前完全不存在 (导航/外链命中 404), 本页补齐。
// 数据: 全部来自既有 BFF 只读端点 /api/session-list (tRPC sessionRegistry.list passthrough)
//       与 /api/session-stats; 本页不做任何写操作, 不直连库。
// 取数: 服务端 force-dynamic 拉取 —— curl 拉到的 SSR HTML 即包含会话行; 取数失败渲染空态, 不白屏。
// 跳转: 整行可点击 -> /sessions/detail?id=<session_uid> (uid 含冒号, 统一 encodeURIComponent)。
import Link from "next/link";
import { UNKNOWN, fmtNum, fmtState, fmtTime } from "@/lib/format";
import { headers } from "next/headers";
import KPICard from "@/components/KPICard";
import SessionsTable, { type SessionItem } from "./_components/SessionsTable";

export const dynamic = "force-dynamic";

interface ListPayload {
  result?: { data?: { items?: SessionItem[]; total?: number } };
  /** 2026-10-26：BFF 现在两条路径都显式给数据源（live:session-list / fallback:…），页面据此提示"可能是旧数据" */
  source?: string;
}
interface StatsPayload { result?: { data?: { total?: number; byStatus?: Record<string, number>; pending24h?: number } }; /** 76-GA: BFF 顶层新增的"数据时刻" */ asOf?: string }

const PAGE_SIZE = 20;

/** 同源 BFF 取数: dev 为本机 http; 失败返回 null, 页面渲染空态而非 500 */
async function bffGet<T>(path: string): Promise<T | null> {
  try {
    const h = headers();
    const host = h.get("host") || `127.0.0.1:${process.env.PORT || 3004}`;
    const res = await fetch(`http://${host}${path}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams?: { page?: string };
}) {
  const page = Math.max(1, Number(searchParams?.page) || 1);
  const list = await bffGet<ListPayload>(`/api/session-list?page=${page}&pageSize=${PAGE_SIZE}`);
  const stats = await bffGet<StatsPayload>("/api/session-stats");
  const items = list?.result?.data?.items ?? [];
  const total = list?.result?.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const byStatus = stats?.result?.data?.byStatus ?? {};
  const listSource = list?.source || "";
  const staleSource = listSource.startsWith("fallback");

  const pagerBtn = {
    padding: "var(--sp-1) var(--sp-2-5)",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    color: "var(--text)",
    textDecoration: "none",
    fontSize: "var(--fs-base)",
  } as const;

  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <span style={{ color: "var(--text-dim)" }}>智能体与能力</span>
          <span className="sep">/</span>
          <span className="current">会话中心</span>
        </div>
        {/* 2026-10-26：数据源回退时**不能静默**——旧数据与活库数据长得一模一样，只有这句话能区分。 */}
      {staleSource ? (
        <div className="data-health" data-state="warn">
          <span className="dh-text">
            会话列表当前取自<b>回退数据源</b>（{listSource}），可能与实时状态不一致；活库恢复后本提示会消失。
          </span>
        </div>
      ) : null}
      <div className="page-header">
          <div className="page-title">会话中心</div>
          <div className="page-subtitle">全部智能体会话 · 点击行查看详情{stats?.asOf ? <span className="tiny" style={{ marginLeft: "var(--sp-2)", color: "var(--text-dim)" }}>数据时刻 {fmtTime(stats.asOf)}</span> : null}</div>
        </div>

        <div className="kpi-grid">
          {/* 2026-10-15（round 76-EQ，规范铁律 2/§1）：这是服务端组件，没有客户端"加载中"态，
              状态只有**成功/失败**；而原来统计取不到时 KPI 会显示 **0** ✗ —— 与"真的是 0"无法分辨。
              区分的关键（实测得出）：**整包取不到**（stats == null）-> 未知；
              **整包在、只是 map 里没这个 key**（实测 byStatus 只有 PROCESSED/SKIPPED）-> 那**真的是 0** ✗ 不能写 —。
              列表那块的失败提示本来就有，保持不动。 */}
          <KPICard label="会话总数" hint="全部智能体累计" value={total ? total.toLocaleString() : fmtState(stats?.result?.data?.total, { error: !stats })} />
          {/* 2026-10-26：stats 改读活库后，状态键从 PROCESSED 变成 DONE（活库四态 DONE/PENDING/FAILED/SKIPPED），
              页面仍只认 PROCESSED → 屏幕上「已提炼」恒为 0（实测 0，而 byStatus.DONE=9899）。
              这里按"活库优先、旧键兜底"取值，并在 hint 写明口径来源，避免下次换源又静默归零。 */}
          <KPICard
            label="已提炼"
            hint="会话已转成认知资产（活库 DONE）"
            value={stats ? fmtNum(byStatus["DONE"] ?? byStatus["PROCESSED"] ?? 0) : UNKNOWN}
          />
          <KPICard label="待提炼" hint="还没跑提炼的会话" value={stats ? fmtNum(byStatus["PENDING"] ?? 0) : UNKNOWN} />
        </div>

        <div className="panel">
          <div className="panel-header"><span className="panel-title">会话列表 (第 {page}/{pages} 页 · 每页 {PAGE_SIZE})</span></div>
          {!list ? (
            <div style={{ padding: "var(--sp-6)", color: "var(--text-dim)" }}>
              会话列表暂不可用 (BFF /api/session-list 取数失败), 请稍后刷新。
            </div>
          ) : (
            <SessionsTable items={items} />
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "var(--sp-2-5)", fontSize: "var(--fs-md)" }}>
            <span style={{ color: "var(--text-dim)" }}>共 {total.toLocaleString()} 条</span>
            <span style={{ display: "flex", gap: "var(--sp-2)" }}>
              {page > 1 && <Link style={pagerBtn} href={`/sessions?page=${page - 1}`}>上一页</Link>}
              {page < pages && <Link style={pagerBtn} href={`/sessions?page=${page + 1}`}>下一页</Link>}
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
