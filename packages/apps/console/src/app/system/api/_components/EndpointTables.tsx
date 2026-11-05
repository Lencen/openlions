"use client";
// system/api 页 · REST / tRPC 端点表 (从 page.tsx 抽出, 页面瘦身)
// 2026-11-05 P2 呈现层改造：两张手写 .tbl 表格换成白名单 DataTable（列与字段不变）；
//   等宽/不换行改由 page.module.css 的 .monoCell/.nowrapCell 表达，内联样式清零。
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import styles from "../page.module.css";

export const REST_ENDPOINTS = [
  ["GET", "/api/v1/memory", "记忆列表"],
  ["GET", "/api/v1/memory/stats", "5表统计"],
  ["GET", "/api/v1/memory/best", "最佳记忆"],
  ["POST", "/api/v1/memory/search", "记忆搜索"],
  ["GET", "/api/v1/memory/themes", "主题列表"],
  ["GET", "/api/v1/platform/health", "平台健康"],
  ["GET", "/api/v1/flywheel/stats", "飞轮统计"],
  ["GET", "/api/v1/flywheel/reflections", "反思列表"],
  ["GET", "/api/v1/flywheel/findings", "结构化发现"],
  ["GET", "/api/v1/flywheel/improving-tasks", "改进任务"],
  ["POST", "/api/v1/flywheel/process", "处理飞轮任务"],
  ["POST", "/api/v1/global-organizer/run", "触发全局整理"],
  ["POST", "/api/v1/scanner/run", "触发扫描"],
];

export const TRPC_ROUTERS = [
  ["memory", "list/get/create/getTierDistribution", "7"],
  ["knowledge", "list/semanticSearch/create", "13"],
  ["reflection", "list/get/resolve", "9"],
  ["practice", "list/get/create", "6"],
  ["skills", "list/getTree/autoUpgrade", "14"],
  ["flywheel", "getStatus/getEvents", "12"],
  ["pipeline", "scan/run/runHermes", "8"],
  ["agent", "list/get/revoke", "6"],
  ["sessionRegistry", "stats/list/uploadSession", "16"],
  ["stats", "getOverview/getFlywheelHealth", "6"],
  ["learning", "listPaths/createLog", "14"],
  ["autoRotation", "getStatus/start/stop", "11"],
];

export function RestEndpointsPanel() {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{t('api.panel.rest')}</span>
      </div>
      <TableCopyButton />
      <DataTable
        rowKey={(_r, i) => i}
        rows={REST_ENDPOINTS}
        columns={[
          {
            key: "method",
            title: "方法",
            render: (r) => (
              <span className={"badge " + (r[0] === "GET" ? "badge-blue" : "badge-yellow") + " " + styles.nowrapCell}>
                {r[0]}
              </span>
            ),
          },
          { key: "path", title: "路径", render: (r) => <span className={styles.monoCell}>{r[1]}</span> },
          { key: "desc", title: "说明", render: (r) => r[2] },
        ]}
      />
    </div>
  );
}

export function TrpcRoutersPanel() {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{t('api.panel.trpc')}</span>
      </div>
      <TableCopyButton />
      <DataTable
        rowKey={(_r, i) => i}
        rows={TRPC_ROUTERS}
        columns={[
          { key: "router", title: t('field.router'), render: (r) => <b className={styles.nowrapCell}>{r[0]}</b> },
          { key: "endpoints", title: "核心端点", render: (r) => <span className={styles.monoCell}>{r[1]}</span> },
          { key: "count", title: "数量", align: "right", render: (r) => <span className="badge badge-blue">{r[2]}</span> },
        ]}
      />
    </div>
  );
}

export default function EndpointTables() {
  return (
    <>
      <RestEndpointsPanel />
      <TrpcRoutersPanel />
    </>
  );
}
