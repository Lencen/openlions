"use client";
import KPICard from "@/components/KPICard";
import Link from "next/link";
import { Alert, Empty } from "@/components/primitives";
import { useApi } from "@/lib/api";
import { t } from "@/i18n";
import { statusLabel } from "@/config/systemLabels";
import ErrorAlert from "@/components/ErrorAlert";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

// 2026-11-05 P2 批8 呈现层：本页内联 style 清零 + 手写 .tbl 表换白名单 DataTable。
//   · 取数（/api/agent-services）、字段名、路由与 i18n 文案一条未动；
//   · 四态不变：错误走 ErrorAlert（可重试）、加载走「加载中」行、空走 Empty、正常走表；
//   · 本页是客户端组件（"use client"），列里的等宽/省略号/色标才可以用 render 函数。

interface S { services?:Array<{id:string;name:string;display_name:string;description:string;endpoint:string;version:string;status:string;enabled:boolean;available_perms?:string[];created_at:string}> }

// 权限数组可能是 JSON 字符串、数组或缺省（口径与改造前逐字一致）
function permText(p: any): string {
  if (typeof p === "string") { try { return JSON.parse(p).join(", "); } catch { return p; } }
  return Array.isArray(p) ? p.join(", ") : "-";
}

export default function BusinessPage() {
  const { data, loading, error, mutate } = useApi<S>("/api/agent-services");
  const servicesRaw = Array.isArray(data) ? data : (data?.services ?? []);
  const services = servicesRaw;

  // 2026-11-05 P2 批8：列定义与原 <thead> 逐列对应（名称 / 显示名 / 版本 / 端点 / 权限 / 状态）。
  //   原来写在 <td> 上的等宽、字号、300px 省略号全部下沉到 module.css，由单元格里的 span 承担。
  const columns: DataColumn<any>[] = [
    { key: "name", title: t("business.col.name"), render: (s) => <span className="nowrap"><b>{s.name}</b></span> },
    { key: "display_name", title: t("business.col.display"), render: (s) => <span className="nowrap">{s.display_name}</span> },
    { key: "version", title: t("business.col.version"), render: (s) => <span className={"nowrap mono " + styles.fsSm}>{s.version}</span> },
    { key: "endpoint", title: t("business.col.endpoint"), render: (s) => <span className={styles.endpoint}>{s.endpoint}</span> },
    { key: "perms", title: t("business.col.perms"), render: (s) => <span className={styles.fsSm}>{permText(s.available_perms)}</span> },
    { key: "status", title: t("business.col.status"), render: (s) => <span className={"badge " + (s.status === "ACTIVE" ? "badge-green" : "badge-yellow")}>{statusLabel(s.status)}</span> },
  ];

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>{t("business.crumb.parent")}</span><span className="sep">/</span><span className="current">{t("business.title")}</span></div>
    <PageHeader><PageTitle>{t("business.title")}</PageTitle><div className="page-subtitle">{loading ? t("business.loading") : t("business.subtitle", { n: services.length })}</div></PageHeader>
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
        <div className={"tiny " + styles.pad4x2}>{t("business.list.loading")}</div>
      ) : services.length === 0 ? (
        <Empty description={t("business.list.empty")} />
      ) : (
        // 2026-10-16 round 77-AS: 待办"7 张表未接复制/导出"的第一张 —— 该表在**表达式**里是唯一子元素,
        // 故按待办所记**手工包一层 Fragment**, 才能与 <TableCopyButton /> 并列 ✓。
        <>
        <TableCopyButton />
        <DataTable<any> columns={columns} rows={services} />
        </>
      )}
    </div>
    {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
    <div className={"tiny " + styles.footLinks}>
      <span>相关视图：</span>
      <Link href="/system/permissions">权限管理 →</Link>
      <Link href="/system/auth">统一认证 →</Link>
    </div>
  </main></div>);
}
