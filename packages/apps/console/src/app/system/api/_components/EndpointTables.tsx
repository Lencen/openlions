"use client";
// system/api 页 · REST / tRPC 端点表 (从 page.tsx 抽出, 页面瘦身)
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";

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
      <table className="tbl">
        <thead>
          <tr>
            <th>方法</th>
            <th>路径</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {REST_ENDPOINTS.map((r, i) => (
            <tr key={i}>
              <td className="nowrap">
                <span
                  className={`badge ${r[0] === "GET" ? "badge-blue" : "badge-yellow"}`}
                >
                  {r[0]}
                </span>
              </td>
              <td
                className="nowrap"
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" }}
              >
                {r[1]}
              </td>
              <td>{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('field.router')}</th>
            <th>核心端点</th>
            <th>数量</th>
          </tr>
        </thead>
        <tbody>
          {TRPC_ROUTERS.map((r, i) => (
            <tr key={i}>
              <td className="nowrap">
                <b>{r[0]}</b>
              </td>
              <td style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" }}>
                {r[1]}
              </td>
              <td className="num">
                <span className="badge badge-blue">{r[2]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
