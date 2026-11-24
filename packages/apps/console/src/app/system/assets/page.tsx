"use client";
// 0.5.1 B5-3 /system/assets · Bento P3/P7 资产可见性（2026-11-15）
// 数据：GET /api/asset-policy（三类策略：mode/selectable/fixedTo）+ GET /api/asset-policy/ownerless（无主存量计数/asOf/stale）。
// 口径：资产清单接口不存在（只有策略与无主计数）→「资产总数/清单」n/a + 原因，不写 0；
//       0.5.1 只读：原页「切换私有」写路径（POST /api/asset-policy）不渲染。
import { useState, useEffect } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import BentoState from "@/components/bento/BentoState";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, States, Tone, usePhaseOverride, useResource } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface KindPolicy { mode?: string; selectable?: boolean; fixedTo?: string | null; defaultMode?: string | null }
interface PolicyResp { ok?: boolean; types?: Record<string, KindPolicy>; hint?: string | null }
interface OwnerlessResp { ok?: boolean; counts?: Record<string, number | null> | null; stale?: boolean; asOf?: string | null; reason?: string }

const KIND_NAME: Record<string, string> = { memory: "记忆", knowledge: "知识", skill: "技能", reflection: "反思" };
const MODE_LABEL: Record<string, string> = { public: "全平台可见", private: "仅所属执行体可见" };

export default function AssetVisibilityPage() {
  const policy = useResource<PolicyResp>("/api/asset-policy", { emptyWhen: (d) => Object.keys(d.types || {}).length === 0 });
  const ownerless = useResource<OwnerlessResp>("/api/asset-policy/ownerless");
  const [reqAt, setReqAt] = useState<string | null>(null);
  useEffect(() => { setReqAt(new Date().toISOString()); }, []);
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : policy.phase;

  const types = policy.data?.types || {};
  const kinds = Object.keys(types);
  const counts = ownerless.data?.counts || null;
  const countValues = kinds.map((k) => counts?.[k]);
  const allCounted = counts != null && countValues.every((v) => typeof v === "number");
  const totalOwnerless = allCounted ? countValues.reduce((a, b) => a + Number(b), 0) : null;
  const publicCount = kinds.filter((k) => (types[k].mode || "public") === "public").length;

  const k = (v: number | null, hint: string): Metric =>
    v == null ? { kind: "na", reason: hint } : { kind: "value", value: fmtNum(v), hint };

  const cols: DataColumn<{ key: string }>[] = [
    { key: "kind", title: "资产类型", width: 140, render: (r) => <b>{KIND_NAME[r.key] || r.key}</b> },
    { key: "mode", title: "可见性", width: 180, render: (r) => <Tone tone="ok">{MODE_LABEL[types[r.key].mode || "public"] || (types[r.key].mode || "n/a")}</Tone> },
    { key: "sel", title: "执行体可否自选", width: 160, render: (r) => types[r.key].selectable ? <Tone tone="info">可自选</Tone> : <Tone tone="mute">不可（平台统一配置）</Tone> },
    { key: "fixed", title: "固定值", render: (r) => <span className={kit.mono}>{types[r.key].fixedTo || types[r.key].defaultMode || "n/a"}</span> },
  ];

  return (
    <main className="page">
      <h1 className={kit.srOnly}>资产可见性</h1>
      <PageHeader>
        <PageTitle>资产可见性</PageTitle>
        <div className="page-subtitle">记忆 / 知识 / 技能三类可见性策略 · 无主存量计数 · 0.5.1 只读 · 数据时刻 {ownerless.data?.asOf ? fmtTime(ownerless.data.asOf) : reqAt ? fmtTime(reqAt) + "（请求时刻；ownerless asOf n/a）" : "n/a（请求时刻未就绪）"}</div>
        <Chips group="系统" page="资产" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/asset-policy" error={policy.error} status={policy.status} onRetry={policy.reload}
        emptyTitle="无资产策略" emptyDetail="策略接口正常返回但没有任何资产类型（空集，不是不可得）。"
        unavailableTitle="资产策略不可得" unavailableDetail="asset-policy 未返回 types；补齐路径：BFF 输出 types 对象。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="资产类型" metric={k(kinds.length, "策略接口返回的类型数")} />
          <KpiTile span={3} label="无主存量合计" metric={k(totalOwnerless, "计数缺失时 n/a；不把取不到当 0")} />
          <KpiTile span={3} label="平台统一可见" metric={k(publicCount, "mode=public 的类型数")} />
          <KpiTile span={3} label="资产总数" metric={{ kind: "na", reason: "无资产清单接口（只有策略与无主计数）——需新 BFF" }} />

          <BentoCard span={8} title="当前策略" sub="由平台统一配置；单个执行体不可更改">
            <DataTable<{ key: string }> columns={cols} rows={kinds.map((key) => ({ key }))} rowKey={(r) => r.key}
              empty={{ title: "无策略数据", desc: "types 为空。" }} />
            <Note>{policy.data?.hint || "selectable=false 时平台把该项固定为固定值，执行体不可选。"}</Note>
          </BentoCard>

          <BentoCard span={4} title="无主存量" sub={ownerless.phase === "ok" ? "GET /api/asset-policy/ownerless · " + (ownerless.data?.asOf ? fmtTime(ownerless.data.asOf) : "asOf n/a") : "计数取不到"}>
            {ownerless.phase === "loading" && <BentoState phase="loading" />}
            {ownerless.phase === "error" && <BentoState phase="error" title="无主存量不可得" detail={"端点 GET /api/asset-policy/ownerless · " + (ownerless.status ? "返回码 " + ownerless.status : ownerless.error) + " · 可重试。"} onRetry={ownerless.reload} />}
            {ownerless.phase === "ok" && (
              <>
                <ul className={kit.kv}>
                  {kinds.map((key) => {
                    const v = counts?.[key];
                    return <li key={key}><span>{KIND_NAME[key] || key}</span><b>{typeof v === "number" ? fmtNum(v) : "n/a（计数缺失）"}</b></li>;
                  })}
                </ul>
                <Note tone={ownerless.data?.stale ? "warn" : "mute"}>
                  {ownerless.data?.stale ? "计数可能不是最新（stale=true）。" : "计数为接口实测值；stale=false。"}
                  计数口径：无归属执行体的历史资产条数（切换可见性只影响此后新写入）。
                </Note>
              </>
            )}
          </BentoCard>

          <BentoCard span={12} title="缺口与只读说明">
            <ul className={kit.kv}>
              <li><span>资产清单 / 资产总数</span><b>n/a —— 平台只有「策略 + 无主计数」两个接口，无资产清单端点；补齐需新 BFF（本批不新增接口）。</b></li>
              <li><span>切换可见性（写）</span><b>0.5.1 只读：原页「切换私有」写路径（POST /api/asset-policy）不渲染，待写通路契约开放。</b></li>
              <li><span>审计</span><b>n/a —— console 无 /api/audit 只读接口（实测 404）；写路径审计在服务端。</b></li>
            </ul>
            <Note>口径：可见性只影响此后新写入的资产；无归属执行体的历史资产保持公开。相关视图：<a className={kit.link} href="/system">系统总览</a> · <a className={kit.link} href="/system/permissions">权限管理</a></Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}