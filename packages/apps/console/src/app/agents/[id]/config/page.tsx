// 0.5.1 B4-11 /agents/[id]/config · Bento 配置（只读，2026-11-15）
// SLOT-MAP（B4 §4）：s12 页头 → s8 配置项只读表（配置项/取值/来源/更新时间）+ s4 生效说明
//   → s12 服务授权（只读）+ s12 相关视图。
// 硬约束（B4 §1 / §4 已批准例外）：**只读，不提供保存**；本页不渲染任何写控件（无 input/button/textarea）。
// 数据：/api/agent-list（profile/quota/permissions）+ /api/agent-services（服务目录）；缺字段 n/a+原因，不写 0。
import type { ReactNode } from "react";
import Link from "next/link";
import AgentShell from "../_components/AgentShell";
import { B4Card, B4Grid, B4Kv, B4PageHead, B4State } from "../_components/B4";
import { TIER_LABELS, fmtTime, loadAgent, loadLive, loadServices, parseJson, parseList } from "../_data";
import { Alert } from "@/components/primitives";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import s from "../_components/b4.module.css";

export const dynamic = "force-dynamic";

type ConfigRow = { key: ReactNode; value: ReactNode; source: ReactNode; updated: ReactNode };
const CONFIG_COLUMNS: DataColumn<ConfigRow>[] = [
  { key: "key", title: "配置项", width: 160 },
  { key: "value", title: "取值" },
  { key: "source", title: "来源", width: 160 },
  { key: "updated", title: "更新时间", width: 150 },
];

type ServiceRow = { name: ReactNode; status: ReactNode; granted: ReactNode; expires: ReactNode };
const SERVICE_COLUMNS: DataColumn<ServiceRow>[] = [
  { key: "name", title: "服务", width: 160 },
  { key: "status", title: "目录状态", width: 100 },
  { key: "granted", title: "已授权权限" },
  { key: "expires", title: "密钥到期", width: 150 },
];

export default async function AgentConfigPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS, servicesS] = await Promise.all([
    loadAgent(id), loadLive(id, "24h"), loadServices(id),
  ]);
  const agent = agentLoad.agent;
  const live = liveS.data;
  const services = servicesS.data ?? [];
  const asOf = agentLoad.asOf || liveS.asOf || null;
  const profile = parseJson(agent?.profile);
  const quota = parseJson(profile.quota);
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const perms = agent?.permissions ?? [];
  const permByService: Record<string, any> = {};
  for (const p of perms) permByService[p.service_name] = p;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push(`实时状态 /api/agents-live（HTTP ${liveS.status ?? "连接失败"}）`);
  if (!servicesS.ok) degraded.push(`服务目录 /api/agent-services（HTTP ${servicesS.status ?? "连接失败"}）`);

  const head = <B4PageHead id={id} page="配置" title="智能体详情 · 配置" subtitle="能力分级、配额与服务授权（只读，不提供保存）" agent={agent} live={live} asOf={asOf} />;
  const fallback = (phase: "empty" | "error", title: string, detail: ReactNode, retry?: string) => (
    <div className="layout-with-sidebar"><main className="main">
      {head}
      <B4Grid><B4Card span={12} state={phase === "error" ? "unavailable" : "ok"}><B4State phase={phase} title={title} detail={detail} retryHref={retry} /></B4Card></B4Grid>
    </main></div>
  );
  if (!id) return fallback("empty", "缺少对象标识", "本页需要智能体 id（/agents/{id}/config）；请从智能体列表进入。", "/agents");
  if (!agentLoad.ok) {
    return fallback("error", "名册接口取数失败", `端点 /api/agent-list 返回 ${agentLoad.status ?? "连接失败"}；这不等于「没有这个智能体」，请稍后重试。`, `/agents/${encodeURIComponent(id)}/config`);
  }
  if (!agent && !live) return fallback("empty", "未找到该智能体", `名册里查不到 ${id}；可能 id 有误或该智能体已下线。`, "/agents");

  const capAt = profile.capabilitySetAt || agent?.updated_at;
  const quotaAt = quota.setAt || agent?.updated_at;
  const configRows: ConfigRow[] = [
    ...(tier != null ? [{ key: "能力分级", value: TIER_LABELS[tier], at: capAt }] : []),
    ...(profile.capabilityReason ? [{ key: "分级理由", value: String(profile.capabilityReason), at: capAt }] : []),
    ...(profile.model ? [{ key: "模型", value: String(profile.model), at: agent?.updated_at }] : []),
    ...(profile.driver ? [{ key: "运行方式", value: String(profile.driver), at: agent?.updated_at }] : []),
    ...(profile.owner ? [{ key: "负责人", value: String(profile.owner), at: agent?.updated_at }] : []),
    ...(profile.toolCapable != null ? [{ key: "工具能力", value: profile.toolCapable ? "有工具" : "无工具", at: agent?.updated_at }] : []),
    ...(profile.persistentWorker != null ? [{ key: "常驻执行器", value: profile.persistentWorker ? "是" : "否", at: agent?.updated_at }] : []),
    ...(quota.dailyLimit != null ? [{ key: "每日上限", value: String(quota.dailyLimit), at: quotaAt }] : []),
    ...(quota.mode ? [{ key: "配额模式", value: String(quota.mode), at: quotaAt }] : []),
    ...(quota.note ? [{ key: "配额说明", value: String(quota.note), at: quotaAt }] : []),
  ].map((r) => ({
    key: <span className={s.sm}>{r.key}</span>,
    value: <span className={s.sm}>{r.value}</span>,
    source: <span className={s.dim + " " + s.sm}>名册画像</span>,
    updated: <span className={s.sm}>{r.at ? fmtTime(r.at) : "n/a（画像未下发时间）"}</span>,
  }));
  // R4（B4-FIELDS §13）：授权记录含 REVOKED，不能与 ACTIVE 混计成"已授权"。
  //   只有 ACTIVE 才展示权限集；REVOKED 明确标"已撤销（历史）"，不并进有效授权。
  const activeCount = perms.filter((p: any) => p.status === "ACTIVE").length;
  const revokedCount = perms.filter((p: any) => p.status === "REVOKED").length;
  const serviceRows: ServiceRow[] = services.map((sv: any) => {
    const perm = permByService[sv.name];
    const active = perm?.status === "ACTIVE";
    const revoked = perm?.status === "REVOKED";
    const granted = active ? parseList(perm.permissions) : [];
    return {
      name: <span className={s.sm}>{sv.display_name || sv.name}</span>,
      status: <span className={sv.status === "ACTIVE" ? "badge badge-green" : "badge"}>{sv.status || "n/a"}</span>,
      granted: active
        ? (granted.length
            ? <span className={s.wrap}>{granted.map((g: string) => <span key={g} className="badge badge-blue">{g}</span>)}</span>
            : <span className={s.dim + " " + s.sm}>已授权（权限集为空）</span>)
        : revoked
          ? <span className={s.dim + " " + s.sm}>已撤销（历史记录，不计入有效授权）</span>
          : <span className={s.dim + " " + s.sm}>未授权</span>,
      expires: <span className={s.sm}>{active && perm?.expires_at ? fmtTime(perm.expires_at) : "n/a（未授权/已撤销）"}</span>,
    };
  });

  return (
    <AgentShell id={id} active="config" agent={agent} live={live} header={head}>
      {degraded.length ? <Alert type="warning" showIcon className={s.alertRow} title="部分数据源降级" description={degraded.join("；")} /> : null}

      <B4Grid>
        <B4Card
          span={8}
          title="配置项"
          sub={`来自名册画像 profile（只读）· ${configRows.length} 项`}
          state={configRows.length ? "ok" : "unavailable"}
          actions={<span className={s.dim + " " + s.sm}>只读</span>}
        >
          {configRows.length ? (
            <div className={s.tableWrap}>
              <DataTable columns={CONFIG_COLUMNS} rows={configRows} />
            </div>
          ) : (
            <B4State phase="empty" title="无配置项" detail="名册 /api/agent-list 的 profile 为空（该智能体未登记画像），没有配置项可展示；不代表配置为 0。" />
          )}
        </B4Card>

        <B4Card span={4} title="生效说明">
          <B4Kv items={[
            { label: "生效来源", value: "名册画像字段（智能体注册表 profile）" },
            { label: "生效范围", value: "能力分级/配额/工具能力影响任务认领与执行；服务授权决定业务密钥" },
            { label: "本页能力", value: "只读渲染；不提供保存（B4 §4 已批准例外）" },
            { label: "变更途径", value: "平台配置流程（before/after + 二次确认），本页不发起写操作" },
            { label: "数据时刻", value: asOf ? fmtTime(asOf) : "n/a（接口未下发 asOf）", mono: true },
          ]} />
          <div className={s.note}>
            权限调整入口已按 0.5.1「详情只读」边界从本页移出；写流程迁移平台配置，不在本批范围内。
          </div>
        </B4Card>

        <B4Card
          span={12}
          title="服务授权"
          sub={`业务服务目录 /api/agent-services × 名册授权 · ${services.length} 个服务 · 有效授权 ${activeCount} / 历史撤销 ${revokedCount}（只读，分列不混计）`}
          state={servicesS.ok ? "ok" : "unavailable"}
          actions={<span className={s.dim + " " + s.sm}>只读</span>}
        >
          {!servicesS.ok ? (
            <B4State
              phase="unavailable"
              title="服务目录不可得"
              detail={`端点 /api/agent-services 返回 ${servicesS.status ?? "连接失败"}；授权矩阵分块 n/a。`}
              retryHref={`/agents/${encodeURIComponent(id)}/config`}
            />
          ) : (
            <div className={s.tableWrap}>
              <DataTable columns={SERVICE_COLUMNS} rows={serviceRows} empty={{ title: "服务目录为空", desc: "/api/agent-services 返回 0 个业务服务。" }} />
            </div>
          )}
        </B4Card>

        <B4Card span={12} title="相关视图">
          <div className={s.related}>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/overview`} className={s.link}>概览 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/runs`} className={s.link}>运行记录 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/versions`} className={s.link}>版本/变更 →</Link>
            <Link href="/agents" className={s.link}>全部智能体 →</Link>
          </div>
        </B4Card>
      </B4Grid>
    </AgentShell>
  );
}
