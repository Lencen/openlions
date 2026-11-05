// 2026-09-18 UI-S6 (Phase3 单屏接真实数据): 本屏原为「占位内容」屏 ——
//   · KPI「工具」写死为 "待统计"
//   · 「技能分类 Top 5」是五行**硬编码数字**(1480/1330/286/285/261)
//   · 「服务」表是两行硬编码行(lions_mind / mcp_agent_chat)
//   本任务验收要求「curl 该路由 HTML 含真实字段」—— 而客户端渲染页的 SSR HTML 里没有数据, curl 无法验证。
//   故本屏改为**服务端组件**: 直接用平台真实接口取数并渲染, 使验收可机器验证, 同时去掉全部占位。
import KPICard from "@/components/KPICard";
import Link from "next/link";
import { t } from "@/i18n";
import { headers } from "next/headers";
import TableCopyButton from "@/components/TableCopyButton";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

// 数据实时: 不做静态化, 保证每次 curl 拿到的是当次真实读数(否则 HTML 会固化在构建时)
export const dynamic = "force-dynamic";

type Stats = {
  data?: {
    tables?: Record<string, number>;
    topics?: { total: number; avgCoverage: number };
    quality?: Record<string, { high: number; mid: number; low: number }>;
    coverageDistribution?: Record<string, number>;
  };
};
type Svc = { name?: string; display_name?: string; status?: string; endpoint?: string; enabled?: boolean };

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const h = headers();
    const host = h.get("host") || `127.0.0.1:${process.env.PORT || 3004}`;
    const r = await fetch(`http://${host}${path}`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
const fmt = (n?: number) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");

export default async function CapabilitiesPage() {
  const [statsRaw, svcRaw] = await Promise.all([getJson<Stats>("/api/stats"), getJson<Svc[]>("/api/services-list")]);
  const d = statsRaw?.data ?? {};
  const tables = d.tables ?? {};
  const quality = d.quality ?? {};
  const topics = d.topics;
  const svc = Array.isArray(svcRaw) ? svcRaw : [];
  const mcpCount = svc.filter((s) => String(s.name || "").toLowerCase().includes("mcp")).length;
  const activeCount = svc.filter((s) => String(s.status || "").toUpperCase() === "ACTIVE").length;
  const qualityRows = Object.entries(quality)
    .filter(([, v]) => v && typeof v.high === "number")
    .map(([k, v]) => ({ k, high: v.high, mid: v.mid ?? 0, low: v.low ?? 0, total: (v.high ?? 0) + (v.mid ?? 0) + (v.low ?? 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const cov = Object.entries(d.coverageDistribution ?? {}).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>{t('capabilities.crumb')}</span><span className="sep">/</span><span className="current">能力中心</span></div>
      <PageHeader>
        <PageTitle>能力中心</PageTitle>
        <div className="page-subtitle">{t('capabilities.subtitle')}</div>
      </PageHeader>
      <div className="kpi-grid">
        {/* KPICard 的 props 是 {label,value,delta,deltaDir}(见 components/KPICard.tsx): 副标题用 delta 传, 不能用 hint */}
        {/* 文案业务化(见 i18n/glossary.ts 单一事实源): 状态不用英文 ACTIVE(用已登记的 status.active); MCP 的业务说法是「工具服务」 */}
        <KPICard label={t('capabilities.service')} value={fmt(svc.length)} delta={t('status.active') + " " + fmt(activeCount)} />
        <KPICard label="工具服务" value={fmt(mcpCount)} delta={"共 " + fmt(svc.length) + " 项服务"} />
        <KPICard label="技能" value={fmt(tables.skill)} delta={"记忆 " + fmt(tables.memory)} />
        {/* 2026-10-13 round 76-EI: 原来显示 toFixed(3) 的**裸比率**(实测 0.416),<br /> */}
        {/*   而同一语义在 /cognitive 已按百分比显示(76-DM 修); 全站同类共 4+ 处, 这里先改无歧义的这处。 */}
        <KPICard label="主题" value={fmt(topics?.total)} delta={"平均覆盖 " + (topics ? (topics.avgCoverage * 100).toFixed(1) + "%" : "—")} />
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-header"><span className="panel-title">认知资产质量分层(真实读数)</span></div>
          <TableCopyButton />
          <table className="tbl"><thead><tr><th>资产</th><th>高</th><th>中</th><th>低</th><th>合计</th></tr></thead><tbody>
            {qualityRows.length === 0
              ? <tr><td colSpan={5} style={{ color: "var(--text-dim)" }}>暂无数据</td></tr>
              : qualityRows.map((r) => (
                <tr key={r.k}>{fmt(r.total) && <td>{r.k}</td>}<td className="num">{fmt(r.high)}</td><td className="num">{fmt(r.mid)}</td><td className="num">{fmt(r.low)}</td><td className="num">{fmt(r.total)}</td></tr>
              ))}
          </tbody></table>
        </div>
        <div className="panel">
          <div className="panel-header"><span className="panel-title">{t('capabilities.service')}</span></div>
          <TableCopyButton />
          <table className="tbl"><thead><tr><th>服务</th><th>状态</th><th>端点</th></tr></thead><tbody>
            {svc.length === 0
              ? <tr><td colSpan={3} style={{ color: "var(--text-dim)" }}>服务清单暂不可读</td></tr>
              : svc.slice(0, 8).map((s) => (
                <tr key={String(s.name)}>
                  <td><b>{s.display_name || s.name}</b></td>
                  <td><span className={"badge " + (String(s.status || "").toUpperCase() === "ACTIVE" ? "badge-green" : "badge-gray")}>{s.status || "UNKNOWN"}</span></td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>{s.endpoint || "—"}</td>
                </tr>
              ))}
          </tbody></table>
        </div>
      </div>
      <div className="panel" style={{ marginTop: "var(--sp-4)" }}>
        <div className="panel-header"><span className="panel-title">主题覆盖度分布(真实读数)</span></div>
        <TableCopyButton />
        <table className="tbl"><thead><tr><th>覆盖区间</th><th>主题数</th></tr></thead><tbody>
          {cov.length === 0
            ? <tr><td colSpan={2} style={{ color: "var(--text-dim)" }}>暂无数据</td></tr>
            : cov.map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{fmt(v)}</td></tr>)}
        </tbody></table>
      </div>
      {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/agents">智能体总览 →</Link>
        <Link href="/system/permissions">业务授权矩阵 →</Link>
      </div>
    </main></div>
  );
}
