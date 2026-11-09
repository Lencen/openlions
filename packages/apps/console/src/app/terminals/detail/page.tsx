"use client";
// 2026-10-29：终端详情（12 层 IA 的第一版实现）。
// 设计依据：docs/productization/TERMINAL-DETAIL-IA-2026-10-27.md
// 三条硬约束：
//   1. **未知不填 0**：块状态 unknown 时显示「未知」+ 原因，不显示 0；
//   2. **待接入项显式列出**：不把"还没做"伪装成"没有数据"；
//   3. 不在前端算指标：聚合值来自 BFF。
// 2026-11-05 P2 批10：呈现层改造 —— 内联 style 72 -> 0、手写 tbl 表格 10 -> 0。
//   本页是客户端组件（文件首行 "use client"），所以 DataTable 允许传 render 函数（服务端页才禁止）；
//   列里只放 render，不传 onRow / onRetry；唯一保留的 rowKey 在「待接入」表（沿用改前的 key=p.block），
//   其余表不传 rowKey —— DataTable 缺省按行下标取 key，与改前的 key={i} 相同。
//   页签选中态是唯一动态样式，改走 [data-active] 属性选择器；其余间距 / 弱化色 / 换行下沉到
//   同目录 page.module.css。未改取数、接口、路由、URL 参数、文案、字段名与导出 props 形状；页头未动。
import { useState } from "react";
import { Alert, Skeleton, Tag } from "@/components/primitives";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { useApi } from "@/lib/api";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

type BlockState = "ok" | "partial" | "unknown";
interface Block {
  status?: string; // 块状态（ok/unknown）；注意与 runtime_status 不同
  reason?: string;
  [k: string]: unknown;
}
interface Resp {
  ok?: boolean;
  asOf?: string;
  provenance?: Record<string, string>;
  build_id?: string;
  provenance_count?: number;
  agent_id?: string;
  blocks?: Record<string, Block>;
  pending?: {
    block: string;
    reason: string;
    dep?: string;
    owner?: string;
    promised?: string;
    ready_when?: string;
    eta?: string;
    now?: string;
  }[];
}

/** 待接入表的一行（原表直接遍历 Resp["pending"] 的元素） */
type PendingRow = NonNullable<Resp["pending"]>[number];
/** 来源表的一行：块名 -> 来源说明 */
type ProvenanceRow = { block: string; source: string };

const TABS = [
  { key: "overview", label: "概览" },
  { key: "ability", label: "能力与规则" },
  { key: "access", label: "权限" },
  { key: "activity", label: "活动" },
  { key: "health", label: "健康" },
  { key: "logs", label: "日志" },
  { key: "config", label: "配置" },
  { key: "gap", label: "待接入" },
] as const;

const UNKNOWN = "未知";

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return UNKNOWN;
  if (typeof v === "number") return v.toLocaleString("zh-CN");
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "string") {
    const d = new Date(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(d.getTime())) {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    return v;
  }
  return String(v);
};

const STATE_LABEL: Record<string, string> = {
  online: "在线",
  offline: "离线",
  busy: "忙碌",
  suspended: "已停用",
  degraded: "降级",
};

// 表格列定义：与改前表头逐列对应（表头文字 / 列宽 / 单元格小字逐条照搬）。
// 客户端页允许传 render；不传 onRow / onRetry。
const SERVICE_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "service_name", title: "服务", render: (it) => fmt(it.service_name) },
  { key: "status", title: "状态", render: (it) => fmt(it.status) },
  { key: "last_error", title: "最近错误", render: (it) => <span className="tiny">{fmt(it.last_error)}</span> },
  { key: "updated_at", title: "更新时间", render: (it) => <span className="tiny">{fmt(it.updated_at)}</span> },
];

const RESOURCE_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "rt", title: "资源类型", render: (r) => fmt(r.rt) },
  { key: "rk", title: "资源", render: (r) => fmt(r.rk) },
  { key: "permission", title: "权限", render: (r) => fmt(r.permission) },
  { key: "effect", title: "效果", render: (r) => fmt(r.effect) },
];

const APPROVAL_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "request_id", title: "申请", render: (r) => <span className="tiny">{fmt(r.request_id)}</span> },
  { key: "decision", title: "决定", render: (r) => fmt(r.decision) },
  { key: "decided_by", title: "决策人", render: (r) => fmt(r.decided_by) },
  { key: "decided_at", title: "时间", render: (r) => <span className="tiny">{fmt(r.decided_at)}</span> },
];

const STAGE_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "stage", title: "阶段", width: 180, render: (r) => fmt(r.stage) },
  { key: "at", title: "时间", width: 170, render: (r) => <span className="tiny">{fmt(r.at)}</span> },
  { key: "source", title: "来源", render: (r) => <span className="tiny">{fmt(r.source)}</span> },
];

const CHANGE_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "at", title: "时间", width: 150, render: (r) => <span className="tiny">{fmt(r.at)}</span> },
  { key: "actor", title: "操作人", width: 110, render: (r) => <span className="tiny">{fmt(r.actor)}</span> },
  { key: "field", title: "字段", width: 130, render: (r) => <span className="tiny">{fmt(r.field)}</span> },
  {
    key: "diff", title: "前 → 后",
    render: (r) => <span className={"tiny " + styles.wrap}>{fmt(r.before)} → {fmt(r.after)}</span>,
  },
];

const PROJECT_SESSION_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "session_id", title: "会话", render: (r) => <span className="tiny">{fmt(r.session_id)}</span> },
  { key: "parent_session_id", title: "上级", render: (r) => <span className="tiny">{fmt(r.parent_session_id)}</span> },
  { key: "label", title: "标签", render: (r) => <span className="tiny">{fmt(r.label ?? r.title)}</span> },
  { key: "status", title: "状态", render: (r) => fmt(r.status) },
  { key: "last_seen_at", title: "最近活动", render: (r) => <span className="tiny">{fmt(r.last_seen_at)}</span> },
];

const HOUR_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "h", title: "小时", render: (r) => <span className="tiny">{fmt(r.h)}</span> },
  { key: "c", title: "心跳数", render: (r) => fmt(r.c) },
];

const LOG_COLUMNS: DataColumn<Record<string, unknown>>[] = [
  { key: "at", title: "时间", width: 150, render: (r) => <span className="tiny">{fmt(r.at)}</span> },
  { key: "source", title: "来源", width: 70, render: (r) => <span className="tiny">{fmt(r.source)}</span> },
  { key: "level", title: "级别", width: 60, render: (r) => <span className="tiny">{r.level === "warn" ? "警告" : "信息"}</span> },
  { key: "text", title: "内容", render: (r) => <span className={"tiny " + styles.wrap}>{fmt(r.text)}</span> },
];

const PENDING_COLUMNS: DataColumn<PendingRow>[] = [
  { key: "block", title: "层 / 块", width: 210, render: (p) => <span className={styles.wrap}>{p.block}</span> },
  { key: "dep", title: "依赖", width: 70, render: (p) => <span className="tiny">{fmt(p.dep)}</span> },
  { key: "owner", title: "归属", width: 150, render: (p) => <span className={"tiny " + styles.wrap}>{fmt(p.owner)}</span> },
  {
    key: "ready_when", title: "就绪判据 / 预计",
    render: (p) => (
      <span className={"tiny " + styles.wrap}>
        {fmt(p.ready_when)}
        {p.eta ? <span className={styles.eta}>预计：{p.eta}</span> : null}
      </span>
    ),
  },
  { key: "now", title: "当前", width: 210, render: (p) => <span className={"tiny " + styles.wrap}>{fmt(p.now)}</span> },
];

const PROVENANCE_COLUMNS: DataColumn<ProvenanceRow>[] = [
  { key: "block", title: "块", width: 140, render: (r) => <span className="tiny">{r.block}</span> },
  { key: "source", title: "来源", render: (r) => <span className={"tiny " + styles.wrap}>{r.source}</span> },
];

function Field({ label, value, unknown }: { label: string; value: unknown; unknown?: boolean }) {
  return (
    <div className={styles.fieldRow}>
      <div className={"tiny " + styles.fieldLabel}>{label}</div>
      <div className={styles.fieldValue}>{unknown ? <span className="tiny">未知</span> : fmt(value)}</div>
    </div>
  );
}

export default function TerminalDetailPage({ searchParams }: { searchParams: { agent_id?: string; changes_demo?: string } }) {
  const agentId = String(searchParams?.agent_id || "").trim();
  // 2026-10-29 修：日志区文案写"按 5 秒轮询"，而 useApi 默认 10s —— 文案与实际不一致就是假承诺。
  //   这里显式设 5000，让"5 秒"这句话成立（日志区是本页唯一需要较高刷新率的块）。
  const { data, loading, error } = useApi<Resp>(
    agentId
      ? `/api/terminal-detail?agent_id=${encodeURIComponent(agentId)}${searchParams?.changes_demo ? "&changes_demo=1" : ""}`
      : "",
    { pollMs: 5000 }
  );
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("overview");

  if (!agentId) {
    return (
      <div className="layout-with-sidebar"><main className="main">
        <PageHeader><PageTitle>终端详情</PageTitle></PageHeader>
        <Alert type="warning" showIcon title="缺少终端标识" description="请从终端列表点进详情。" />
      </main></div>
    );
  }

  const b = data?.blocks ?? {};
  const vRaw = b.runtime?.client_version_state as { state?: string; min?: string; next?: string } | null | undefined;
  const vState = {
    state: (vRaw?.state as string) || "unknown",
    min: vRaw?.min || "",
    next: vRaw?.next || "",
  };
  const st = (k: string): BlockState => {
    const s = b[k]?.status;
    return s === "ok" ? "ok" : s === "partial" ? "partial" : "unknown";
  };

  const badge = (state: BlockState) =>
    state === "ok" ? <Tag color="green">已接入</Tag>
    : state === "partial" ? <Tag color="yellow">部分</Tag>
    : <Tag>未知</Tag>;

  const pendingRows: PendingRow[] = data?.pending ?? [];
  const provenanceRows: ProvenanceRow[] = Object.entries((data?.provenance ?? {}) as Record<string, string>).map(([k, v]) => ({ block: k, source: v }));

  return (
    <div className="layout-with-sidebar"><main className="main">
      <PageHeader>
        <PageTitle>{fmt(b.identity?.display_name) === UNKNOWN ? agentId : fmt(b.identity?.display_name)}</PageTitle>
        <div className="page-subtitle">
          终端详情 · {agentId} · 数据时刻 {fmt(data?.asOf)}
        </div>
      </PageHeader>

      {/* 顶部四灯：运行时 / 接入 / 通信 / 工作 —— 四种故障域分开，避免"在线却收不到消息"被读成一个状态 */}
      <div className={"kpi-grid " + styles.kpiGrid}>
        {[
          { k: "runtime", label: "运行时", value: STATE_LABEL[String(b.runtime?.runtime_status)] ?? fmt(b.runtime?.runtime_status) },
          {
            k: "access",
            label: "平台接入",
            value: b.access?.granted === false
              ? "未授予"
              : b.access?.scope
                ? String(b.access.scope)
                : b.access?.granted
                  ? "已授权（未设档位）"
                  : UNKNOWN,
          },
          { k: "comm", label: "通信", value: b.comm?.attempts_24h === 0 ? "24h 无投递" : fmt(b.comm?.delivered_24h) },
          { k: "work", label: "工作", value: b.work?.open_todos === null ? UNKNOWN : fmt(b.work?.open_todos) },
        ].map((x) => (
          <div className="panel" key={x.k}>
            <div className="panel-header"><div className={"panel-title " + styles.panelTitleNowrap}>{x.label}</div></div>
            <div className={styles.kpiBody}>
              <div className={styles.kpiValue}>{x.value}</div>
              <div className={"tiny " + styles.kpiBadge}>{badge(st(x.k))}</div>
            </div>
          </div>
        ))}
      </div>

      {b.cost?.cost_reason ? (
        <div className={"panel " + styles.panelBlock}>
          <div className={"tiny " + styles.notePad}>
            <b>数据质量提示：</b>{String(b.cost?.cost_reason ?? "")}。这不是"成本为 0"，而是当前采集不到；配额类判断请勿以此页为准。
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className={"panel-header " + styles.tabBar}>
          {TABS.map((t) => (
            <button
              key={t.key}
              className={"tab" + (tab === t.key ? " active" : "") + " " + styles.tabBtn}
              data-active={tab === t.key ? "true" : "false"}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.tabBody}>
          {error ? (
            <Alert type="warning" showIcon title="读数暂时取不到" description="这不代表该终端没有数据；稍后刷新即可。" />
          ) : loading ? (
            <Skeleton paragraph={{ rows: 6 }} />
          ) : (
            <>
              {tab === "overview" && (
                <>
                  <Field label="唯一标识" value={b.identity?.agent_id} />
                  <Field label="通道类型" value={b.identity?.channel} />
                  <Field label="角色 / 租户" value={[b.identity?.role, b.identity?.tenant_id].filter(Boolean).join(" / ")} />
                  <Field label="运行主机" value={b.identity?.host} />
                  <Field label="回调地址" value={b.identity?.bridge_url} />
                  <Field label="注册时间" value={b.identity?.registered_at} />
                  <Field label="最近心跳" value={b.runtime?.last_seen} />
                  <Field
                    label="客户端版本"
                    value={
                      vState.state === "unknown"
                        ? "尚未上报（等客户端上报版本）"
                        : vState.state === "upgrade_available"
                          ? `${fmt(b.runtime?.client_version)}（有新版本可升级，推荐）`
                          : vState.state === "unsupported"
                            ? `${fmt(b.runtime?.client_version)}（低于最低支持版本 ${vState.min}）`
                            : fmt(b.runtime?.client_version)
                    }
                  />
                  {vState.state === "upgrade_available" ? (
                    <div className={"tiny " + styles.versionHint}>
                      新版本 {vState.next} 已发布，不强制；升级后可获得规则同步与更完整的健康读数。
                    </div>
                  ) : null}
                  <Field label="运行包版本" value={b.runtime?.package_version} />
                  <Field label="接入规范版本" value={[b.runtime?.sdk_version, b.runtime?.sop_version].filter(Boolean).join(" / ")} />
                  <Field label="接入规范合规" value={b.runtime?.sop_compliant} />
                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>来源与接入</div>
                    <Field label="首次出现" value={b.origin?.first_seen_at} />
                    <Field label="来源平台数" value={b.origin?.source_platforms} />
                    <Field label="审批人" value={b.origin?.approved_by} />
                    <Field label="审批时间" value={b.origin?.approved_at} />
                    <Field label="审批备注" value={b.origin?.approval_note} />
                    <Field label="注册方式 / 协议版本" value="待接入（D1）" />
                  </div>
                </>
              )}

              {tab === "ability" && (
                <>
                  <Field label="厂商 / 模型" value={[b.identity?.vendor, b.persona?.model].filter(Boolean).join(" / ")} />
                  <Field label="能力清单" value={Array.isArray(b.identity?.capabilities) ? (b.identity?.capabilities as string[]).join("、") : b.identity?.capabilities} />
                  <Field label="简介" value={b.identity?.bio} />
                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>性格（来自档案）</div>
                    <Field label="性格" value={b.persona?.personality} />
                    <Field label="语气" value={b.persona?.tone} />
                    <Field label="价值观" value={b.persona?.core_values} />
                    <Field label="回复风格" value={b.persona?.response_style} />
                    <Field label="专长" value={Array.isArray(b.persona?.specialties) ? (b.persona?.specialties as string[]).join("、") : b.persona?.specialties} />
                  </div>
                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>接入规范</div>
                    <Field label="规范版本" value={b.persona?.sop_version} />
                    <Field label="规范合规" value={b.persona?.sop_compliant} />
                    <Field label="接受时间" value={b.persona?.sop_accepted_at} />
                  </div>
                  <div className={styles.section}>
                    <Alert
                      type="info"
                      showIcon
                      title="人格来源 / 人格摘要 / 规则确认版本：待接入（D1、D2）"
                      description="裁定①要求终端上报人格来源与摘要；这些字段与客户端上报尚未上线，本块显示「待接入」而不是「无」。"
                    />
                  </div>
                </>
              )}

              {tab === "access" && (
                <>
                  {st("access") === "unknown" ? (
                    <Alert type="warning" showIcon title={`平台接入：${UNKNOWN}`} description={b.access?.reason || "没有授权行或暂时取不到"} />
                  ) : (
                    <>
                      <Field label="身份档位" value={b.access?.scope} />
                      <Field label="授权状态" value={b.access?.permission_status} />
                      <Field label="到期时间" value={b.access?.expires_at} />
                      <Field label="最近使用" value={b.access?.last_used_at} />
                    </>
                  )}
                  <div className={styles.section}>
                    <div className={"tiny " + styles.subhead}>服务与权限矩阵（最近 20 条）</div>
                    {Array.isArray(b.services?.items) && (b.services?.items as Record<string, unknown>[]).length ? (
                      <DataTable columns={SERVICE_COLUMNS} rows={b.services?.items as Record<string, unknown>[]} />
                    ) : (
                      <div className="tiny">未知（暂时取不到服务矩阵）</div>
                    )}
                  </div>
                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>资源权限</div>
                    {Array.isArray(b.permissions?.resource) && (b.permissions?.resource as unknown[]).length ? (
                      <DataTable columns={RESOURCE_COLUMNS} rows={b.permissions?.resource as Record<string, unknown>[]} />
                    ) : <div className="tiny">无记录</div>}
                  </div>
                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>分组 / 凭据 / 徽章</div>
                    <Field label="所属分组" value={Array.isArray(b.permissions?.groups) && (b.permissions?.groups as unknown[]).length ? "有" : "无"} />
                    <Field label="服务凭据数" value={Array.isArray(b.permissions?.credentials) ? (b.permissions?.credentials as unknown[]).length : null} />
                    <Field label="徽章数" value={Array.isArray(b.permissions?.badges) ? (b.permissions?.badges as unknown[]).length : null} />
                  </div>
                </>
              )}

              {tab === "activity" && (
                <>
                  <Field label="会话数" value={b.activity?.sessions} />
                  <Field label="消息数" value={b.activity?.messages} />
                  <Field label="用量合计" value={b.activity?.tokens} />
                  <Field label="估算成本（USD）" value={b.activity?.cost_usd} />
                  <Field label="平台配额（终端数）" value={b.cost?.quota_max_agents} />
                  <Field label="授权状态 / 剩余天数" value={[b.cost?.quota_license_state, b.cost?.quota_days_left].filter((x) => x !== null && x !== undefined && x !== "").join(" / ")} />
                  <div className={"tiny " + styles.noteTight}>{String(b.cost?.quota_scope_note ?? "")}</div>
                  <Field label="最近会话" value={b.activity?.last_session_at} />
                  <div className={styles.section}>
                    <Field label="未结待办" value={b.work?.open_todos} />
                    <Field
                      label="最老待办"
                      value={
                        typeof b.work?.oldest_todo_ms === "number"
                          ? `${Math.max(0, Math.round((Date.now() - Number(b.work.oldest_todo_ms)) / 86400000))} 天前`
                          : b.work?.oldest_todo_ms
                      }
                    />
                  </div>
                  {(b.cost?.cost_reason || b.cost?.tokens_reason) ? (
                    <div className={"tiny " + styles.noteTop}>
                      {[b.cost?.cost_reason, b.cost?.tokens_reason].filter(Boolean).join("；")}
                    </div>
                  ) : null}
                  <div className={styles.section}>
                    <div className="tiny">24h 投递：{fmt(b.comm?.delivered_24h)} / {fmt(b.comm?.attempts_24h)}（成功/尝试）</div>
                    <div className="tiny">最近心跳事件：{fmt((b.comm?.last_event as Record<string, unknown> | null)?.event_type)}</div>
                  </div>

                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>审批记录（最近 20）</div>
                    {Array.isArray(b.events?.approvals) && (b.events?.approvals as unknown[]).length ? (
                      <DataTable columns={APPROVAL_COLUMNS} rows={b.events?.approvals as Record<string, unknown>[]} />
                    ) : <div className="tiny">无记录</div>}
                  </div>

                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>生命周期（阶段时间线）</div>
                    {Array.isArray(b.lifecycle?.stages) && (b.lifecycle?.stages as unknown[]).length ? (
                      <DataTable columns={STAGE_COLUMNS} rows={b.lifecycle?.stages as Record<string, unknown>[]} />
                    ) : <div className="tiny">无记录</div>}
                    <div className={"tiny " + styles.noteTop}>{String(b.lifecycle?.diff_unavailable_reason ?? "")}</div>

                    <div className={"tiny " + styles.blockHead}>
                      变更流水（字段级 before → after）
                    </div>
                    {Array.isArray(b.changes?.items) && (b.changes?.items as unknown[]).length ? (
                      <DataTable columns={CHANGE_COLUMNS} rows={b.changes?.items as Record<string, unknown>[]} />
                    ) : (
                      <div className={"tiny " + styles.dimText}>
                        {b.changes?.available
                          ? // 接口已上线但确实没有变更：说"自 X 起没有变更"，不说"暂无记录"（后者会被读成"没在记"）
                            `自 ${String(b.changes?.since ?? "采集起始日")} 起没有变更记录；此前历史不可得`
                          : String(b.changes?.reason ?? "变更流水接口尚未上线")}
                      </div>
                    )}
                  </div>

                  <div className={styles.section}>
                    <div className={"tiny " + styles.subheadDim}>
                      参与（会话层级，最近 20）
                    </div>
                    {b.projects?.reserved ? (
                      <div className={"tiny " + styles.subhead}>
                        <b>项目：预留字段。</b>{String(b.projects?.reserved_reason ?? "")}
                      </div>
                    ) : null}
                    {Array.isArray(b.projects?.sessions) && (b.projects?.sessions as unknown[]).length ? (
                      <DataTable columns={PROJECT_SESSION_COLUMNS} rows={b.projects?.sessions as Record<string, unknown>[]} />
                    ) : <div className="tiny">无记录</div>}
                  </div>
                </>
              )}

              {tab === "health" && (
                <>
                  {st("health") === "unknown" ? (
                    <Alert type="warning" showIcon title="健康：未知" description={String(b.health?.reason ?? "心跳历史暂时取不到")} />
                  ) : (
                    <>
                      <Field label="观测窗口（秒）" value={b.health?.span_s} />
                      <Field label="心跳次数" value={b.health?.beats_7d} />
                      <Field label="窗口内覆盖率" value={b.health?.coverage_pct_span === null ? null : `${fmt(b.health?.coverage_pct_span)}%`} />
                      <Field label="最长心跳间隔（秒）" value={b.health?.max_gap_s} />
                      <Field label="最近心跳" value={b.health?.last_beat_at} />
                      <div className={"tiny " + styles.noteTop}>
                        覆盖率 = 观测窗口内实际心跳次数 ÷ 按 30 秒一次应有次数。窗口很短时它不代表"7 天在线率"，
                        需要积累至少 7 天数据才有意义。
                      </div>
                      <div className={styles.section}>
                        <div className={"tiny " + styles.subheadDim}>按小时分布（最近 48 条）</div>
                        {Array.isArray(b.health?.hours) && (b.health?.hours as unknown[]).length ? (
                          <DataTable columns={HOUR_COLUMNS} rows={b.health?.hours as Record<string, unknown>[]} />
                        ) : <div className="tiny">无记录</div>}
                      </div>
                    </>
                  )}
                </>
              )}

              {tab === "logs" && (
                <>
                  <div className={"tiny " + styles.subhead}>
                    {String(b.logs?.poll_hint ?? "")}
                  </div>
                  {Array.isArray(b.logs?.items) && (b.logs?.items as unknown[]).length ? (
                    <DataTable columns={LOG_COLUMNS} rows={b.logs?.items as Record<string, unknown>[]} />
                  ) : <div className="tiny">无记录</div>}
                  <div className={"tiny " + styles.noteTop}>{String(b.logs?.pending_note ?? "")}</div>
                </>
              )}

              {tab === "config" && (
                <>
                  {st("policy") === "unknown" ? (
                    <Alert type="warning" showIcon title="数据可见性：未知" description={b.policy?.reason || "平台尚未配置"} />
                  ) : (
                    <>
                      <Field label="记忆可见性" value={b.policy?.memory_mode} />
                      <Field label="知识可见性" value={b.policy?.knowledge_mode} />
                      <Field label="技能可见性" value={b.policy?.skill_mode} />
                      <Field label="策略接受时间" value={b.policy?.accepted_at} />
                    </>
                  )}
                  <div className={"tiny " + styles.noteBlock}>
                    可见性由平台统一配置（老板裁定②），终端只展示并服从，不能自行声明。
                  </div>
                </>
              )}

              {tab === "gap" && (
                <>
                  <div className={"tiny " + styles.subhead}>
                    以下不是「没有数据」，而是**还没接入**。列出来是为了不让"未实现"看起来像"正常为空"。
                  </div>
                  <div className={"tiny " + styles.subhead}>
                    下方"当前"列是**实时探测结果**，不是转述承诺——这样"在等谁、等到哪一步"不用问人。
                  </div>
                  <DataTable columns={PENDING_COLUMNS} rows={pendingRows} rowKey={(p) => p.block} empty={{ title: "—" }} />

                  <div className={"tiny " + styles.blockHead}>
                    数据来源（每个数字从哪来；同一时刻 {fmt(data?.asOf)} 取数）
                  </div>
                  <DataTable columns={PROVENANCE_COLUMNS} rows={provenanceRows} rowKey={(r) => r.block} empty={{ title: "—" }} />
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div className={"tiny " + styles.pageFoot}>
        本页自证：数据时刻 {fmt(data?.asOf)} · 构建 {fmt(data?.build_id)} · 来源声明 {fmt(data?.provenance_count)} 条
        （截图据此可追溯到"哪个版本、什么时候抓的"）
      </div>
    </main></div>
  );
}
