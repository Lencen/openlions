// Phase0.5 路由先行 (2026-09-17): /sessions 会话中心列表页
// 运营反馈: 会话中心路由此前完全不存在 (导航/外链命中 404), 本页补齐。
// 数据: 全部来自既有 BFF 只读端点 /api/session-list (tRPC sessionRegistry.list passthrough)
//       与 /api/session-stats; 本页不做任何写操作, 不直连库。
// 取数: 服务端 force-dynamic 拉取 —— curl 拉到的 SSR HTML 即包含会话行; 取数失败渲染空态, 不白屏。
// 跳转: 整行可点击 -> /sessions/detail?id=<session_uid> (uid 含冒号, 统一 encodeURIComponent)。
//
// 2026-11-04 ord-20261104-032 P1 列表模板改造（只改呈现层）：
//   页头 PageHeader → 指标带 KpiCard(3) → 工具条(search + FilterBar) → DataTable → 计数分页。
//   取数（bffGet / 端点 / 分页参数）与字段口径未改；列表主体在 ./_components/SessionsList（client 岛，
//   因为搜索/筛选/排序需要状态，而本页必须保持服务端渲染的 SSR HTML）。
import Link from "next/link";
import { UNKNOWN, fmtNum, fmtState, fmtTime } from "@/lib/format";
import { headers } from "next/headers";
import SessionsList, { type SessionItem } from "./_components/SessionsList";
import { PageHeader, PageTitle, KpiCard, StateBlock, Pill } from "@/components/ui";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

interface ListPayload {
  result?: { data?: { items?: SessionItem[]; total?: number } };
  /** 2026-10-26：BFF 现在两条路径都显式给数据源（live:session-list / fallback:…），页面据此提示"可能是旧数据" */
  source?: string;
}
interface StatsPayload { result?: { data?: { total?: number; byStatus?: Record<string, number>; pending24h?: number } }; /** 76-GA: BFF 顶层新增的"数据时刻" */ asOf?: string }

const PAGE_SIZE = 20;

/** 同源 BFF 取数: dev 为本机 http; 失败返回 null, 页面渲染空态而非 500。
 *  注（P1 遗留）：这里 **不透露 HTTP 状态码**，所以 401/403 与 500 在页面上会合并成同一条错误态。
 *  要让「无权限」成为可区分的状态，需要 BFF/取数层把 status 透出来 —— 属于数据层改动，不在本批。 */
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

  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <span className={styles.crumbDim}>智能体与能力</span>
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
        <PageHeader>
          <PageTitle>会话中心</PageTitle>
          <div className="page-subtitle">
            全部智能体会话 · 点击行查看详情
            {stats?.asOf ? <span className="tiny"> 数据时刻 {fmtTime(stats.asOf)}</span> : null}
          </div>
          <div className={styles.headMeta}>
            <Pill tone="mute">只读</Pill>
            <span className="tiny">筛选 / 排序只作用于本页，不改变服务端分页</span>
          </div>
        </PageHeader>

        <div className="kpi-grid">
          {/* 2026-10-15（round 76-EQ，规范铁律 2/§1）：这是服务端组件，没有客户端"加载中"态，
              状态只有**成功/失败**；而原来统计取不到时 KPI 会显示 **0** ✗ —— 与"真的是 0"无法分辨。
              区分的关键（实测得出）：**整包取不到**（stats == null）-> 未知；
              **整包在、只是 map 里没这个 key**（实测 byStatus 只有 PROCESSED/SKIPPED）-> 那**真的是 0** ✗ 不能写 —。
              列表那块的失败提示本来就有，保持不动。 */}
          <KpiCard label="会话总数" hint="全部智能体累计" value={total ? total.toLocaleString() : fmtState(stats?.result?.data?.total, { error: !stats })} />
          {/* 2026-10-26：stats 改读活库后，状态键从 PROCESSED 变成 DONE（活库四态 DONE/PENDING/FAILED/SKIPPED），
              页面仍只认 PROCESSED → 屏幕上「已提炼」恒为 0（实测 0，而 byStatus.DONE=9899）。
              这里按"活库优先、旧键兜底"取值，并在 hint 写明口径来源，避免下次换源又静默归零。 */}
          <KpiCard
            label="已提炼"
            hint="会话已转成认知资产（活库 DONE）"
            value={stats ? fmtNum(byStatus["DONE"] ?? byStatus["PROCESSED"] ?? 0) : UNKNOWN}
          />
          <KpiCard label="待提炼" hint="还没跑提炼的会话" value={stats ? fmtNum(byStatus["PENDING"] ?? 0) : UNKNOWN} />
        </div>

        {!list ? (
          // 四态的「错误 / 无权限」：两者在服务端合并（bffGet 丢弃状态码，见文件头注释），
          // 这里把两种可能和开通路径都写清楚，并给整页可点的重试出口。
          <StateBlock
            title="会话列表暂不可用"
            desc={
              <>
                BFF <code>/api/session-list</code> 未返回 2xx（服务端取数失败）。若为 <b>401/403（无权限 / 未授权）</b>，
                说明当前账号缺少「会话管理」读权限 <code>会话管理</code>，请联系平台管理员在权限配置里为该线开通；
                若是服务端错误，请稍后重试。
              </>
            }
            action={<a className="btn" href="/sessions">重试</a>}
          />
        ) : (
          <>
            <SessionsList items={items} total={total} page={page} pages={pages} />
            <div className={styles.pager}>
              <span>
                共 {total.toLocaleString()} 条 · 第 {page}/{pages} 页 · 每页 {PAGE_SIZE}
              </span>
              <span className={styles.pagerLinks}>
                {page > 1 ? <Link className={styles.pagerBtn} href={`/sessions?page=${page - 1}`}>上一页</Link> : null}
                {page < pages ? <Link className={styles.pagerBtn} href={`/sessions?page=${page + 1}`}>下一页</Link> : null}
              </span>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
