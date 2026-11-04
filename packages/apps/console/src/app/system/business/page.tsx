"use client";
import KPICard from "@/components/KPICard";
import Link from "next/link";
import { Alert, Empty } from "@/components/primitives";
import { useApi } from "@/lib/api";
import { t } from "@/i18n";
import { statusLabel } from "@/config/systemLabels";
import ErrorAlert from "@/components/ErrorAlert";
import TableCopyButton from "@/components/TableCopyButton";
interface S { services?:Array<{id:string;name:string;display_name:string;description:string;endpoint:string;version:string;status:string;enabled:boolean;available_perms?:string[];created_at:string}> }
export default function BusinessPage() {
  const { data, loading, error, mutate } = useApi<S>("/api/agent-services");
  const servicesRaw = Array.isArray(data) ? data : (data?.services ?? []);
  const services = servicesRaw;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>{t("business.crumb.parent")}</span><span className="sep">/</span><span className="current">{t("business.title")}</span></div>
    <div className="page-header"><div className="page-title">{t("business.title")}</div><div className="page-subtitle">{loading ? t("business.loading") : t("business.subtitle", { n: services.length })}</div></div>
    <div className="kpi-grid">
      <KPICard label={t("business.kpi.total")} value={services.length.toString()} />
      <KPICard label={t("status.active")} value={services.filter(s=>s.status==="ACTIVE").length.toString()} />
      <KPICard label={t("business.kpi.auth")} value={t("business.kpi.authValue")} />
      <KPICard label={t("business.kpi.rbac")} value={t("business.kpi.rbacValue")} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">{t("business.panel.title")} {loading && "（" + t("business.loading") + "）"}</span></div>
      {error ? (
        <ErrorAlert title="服务列表加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} />
      ) : loading ? (
        <div className="tiny" style={{ padding: "var(--sp-4) var(--sp-2)" }}>{t("business.list.loading")}</div>
      ) : services.length === 0 ? (
        <Empty description={t("business.list.empty")} />
      ) : (
        // 2026-10-16 round 77-AS: 待办"7 张表未接复制/导出"的第一张 —— 该表在**表达式**里是唯一子元素,
        // 故按待办所记**手工包一层 Fragment**, 才能与 <TableCopyButton /> 并列 ✓。
        <>
        <TableCopyButton />
        <table className="tbl"><thead><tr><th>{t("business.col.name")}</th><th>{t("business.col.display")}</th><th>{t("business.col.version")}</th><th>{t("business.col.endpoint")}</th><th>{t("business.col.perms")}</th><th>{t("business.col.status")}</th></tr></thead><tbody>
          {services.map((s,i)=>(<tr key={i}>
            <td className="nowrap"><b>{s.name}</b></td>
            <td className="nowrap">{s.display_name}</td>
            <td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{s.version}</td>
            <td style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.endpoint}</td>
            <td style={{ fontSize: "var(--fs-sm)" }}>{(() => { const p = s.available_perms; if (typeof p === "string") { try { return JSON.parse(p).join(", "); } catch { return p; } } return Array.isArray(p) ? p.join(", ") : "-"; })()}</td>
            <td><span className={`badge ${s.status==="ACTIVE"?"badge-green":"badge-yellow"}`}>{statusLabel(s.status)}</span></td>
          </tr>))}
        </tbody></table>
        </>
      )}
    </div>
    {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/system/permissions">权限管理 →</Link>
      <Link href="/system/auth">统一认证 →</Link>
    </div>
  </main></div>);
}