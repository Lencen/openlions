"use client";
// 0.5.1 B5-7 /system/guards · Bento P1/P4 列表（2026-11-15）
// 数据：GET /guard-registry.json（静态注册表：generatedAt/fingerprint/totals/layers/guards[]）。
// 口径：registry 是「快照」，generatedAt 非实时（本次实测 2026-11-13，期间脚本变更需重生成）→ 页面必须标「快照/生成于」；
//       注册表无运行时触发计数 → 「触发数/最近触发」n/a + 原因；0.5.1 只读，无写控件。
import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, FilterBtn, KpiTile, Note, Search, States, Tone, Toolbar, usePhaseOverride, useResource } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface Guard { id: string; layer: string; name: string; file: string; line: number; trigger: string; action: string; note: string; recompute: string }
interface Layer { id: string; name: string; desc: string; trigger: string; count: number }
interface Registry { generatedAt: string; fingerprint: string; description: string; totals: { all: number; byLayer: Record<string, number> }; layers: Layer[]; guards: Guard[] }

const PAGE_STEP = 40;

export default function GuardsPage() {
  const res = useResource<Registry>("/guard-registry.json", { emptyWhen: (d) => !Array.isArray(d.guards) || d.guards.length === 0 });
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : res.phase;
  const reg = res.data;
  const [layer, setLayer] = useState("ALL");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(20);

  const guards = useMemo(() => {
    if (!reg) return [];
    const kw = q.trim().toLowerCase();
    return reg.guards.filter((g) =>
      (layer === "ALL" || g.layer === layer) &&
      (!kw || (g.name + " " + g.note + " " + g.file + " " + g.trigger + " " + g.id).toLowerCase().includes(kw))
    );
  }, [reg, layer, q]);
  const visible = guards.slice(0, shown);

  const k = (v: number | null | undefined, hint: string): Metric =>
    v == null ? { kind: "na", reason: "接口未返回该字段" } : { kind: "value", value: fmtNum(v), hint };

  const cols: DataColumn<Guard>[] = [
    { key: "layer", title: "层", width: 60, render: (g) => <Tone tone="info">{g.layer}</Tone> },
    { key: "name", title: "守卫 / 说明", width: 230, render: (g) => <><b className={kit.mono}>{g.name}</b>{g.note ? <div className={kit.muted}>{g.note}</div> : null}</> },
    { key: "trigger", title: "触发", width: 200, render: (g) => <span className={kit.muted}>{g.trigger || "n/a"}</span> },
    { key: "file", title: "源码位置", width: 230, render: (g) => <span className={kit.mono}>{g.file ? g.file + ":" + g.line : "n/a"}</span> },
    { key: "recompute", title: "复算命令", render: (g) => <span className={kit.mono}>{g.recompute || "n/a"}</span> },
  ];

  return (
    <main className="page" data-slot="system-guards-page">
      <h1 className={kit.srOnly}>守门规则管理</h1>
      <PageHeader>
        <PageTitle>守门规则管理</PageTitle>
        <div className="page-subtitle">
          平台守门机制单一入口（源码自动抽取） · 快照生成于 {reg ? fmtTime(reg.generatedAt) : "n/a（未加载）"} · 非实时
        </div>
        <Chips group="系统" page="守卫" />
      </PageHeader>

      <States phase={phase} endpoint="GET /guard-registry.json" error={res.error} status={res.status} onRetry={res.reload}
        emptyTitle="无守卫" emptyDetail="注册表正常读取但 guards 为空（空集；需运行 guard-registry.cjs --write 重建）。"
        unavailableTitle="守卫注册表不可得" unavailableDetail="静态注册表未返回 guards；补齐路径：node scripts/guard-registry.cjs --write。" />

      {phase === "ok" && reg && (
        <BentoGrid>
          <KpiTile span={3} label="守门总数" metric={k(reg.totals?.all, "registry.totals.all（快照）")} />
          <KpiTile span={3} label="覆盖层数" metric={k(reg.layers?.length, "registry.layers 层数")} />
          <KpiTile span={3} label="提交前（L1）" metric={k(reg.totals?.byLayer?.L1, "byLayer.L1")} />
          <KpiTile span={3} label="巡检 + 判据（L2+L3）" metric={reg.totals?.byLayer ? { kind: "value", value: fmtNum((reg.totals.byLayer.L2 || 0) + (reg.totals.byLayer.L3 || 0)), hint: "L2 巡检 + L3 判据（不含 L4–L6）" } : { kind: "na", reason: "byLayer 未下发" }} />

          <BentoCard span={8} title="逐条清单" sub={"共 " + fmtNum(reg.totals?.all ?? guards.length) + " 条 · 当前筛选 " + fmtNum(guards.length) + " 条 · 快照生成于 " + fmtTime(reg.generatedAt)}>
            <Toolbar right="只读 · /guard-registry.json（快照）">
              <FilterBtn on={layer === "ALL"} onClick={() => { setLayer("ALL"); setShown(20); }}>全部</FilterBtn>
              {(reg.layers || []).map((l) => (
                <FilterBtn key={l.id} on={layer === l.id} onClick={() => { setLayer(l.id); setShown(20); }}>{l.id}（{l.count}）</FilterBtn>
              ))}
              <Search value={q} onChange={(v) => { setQ(v); setShown(20); }} placeholder="搜索 名称 / 说明 / 路径 / 触发" />
            </Toolbar>
            <DataTable<Guard> columns={cols} rows={visible} rowKey={(g) => g.id}
              empty={{ title: "无匹配守卫", desc: "筛选/搜索条件下没有守卫；清空筛选可看全部。" }} />
            <div className={kit.toolbar}>
              <span className={kit.pageInfo}>已显示 {fmtNum(visible.length)} / 共 {fmtNum(guards.length)} 条</span>
              <span className={kit.spacer} />
              {guards.length > shown ? (
                <button type="button" className={kit.pbtn} onClick={() => setShown((v) => v + PAGE_STEP)}>显示更多（+{PAGE_STEP}）</button>
              ) : <span className={kit.muted}>已到底</span>}
            </div>
          </BentoCard>

          <BentoCard span={4} title="快照信息" sub="非实时：registry 为静态文件">
            <ul className={kit.kv}>
              <li><span>生成时刻</span><b>{fmtTime(reg.generatedAt)}（快照，非实时）</b></li>
              <li><span>指纹</span><b className={kit.mono}>{reg.fingerprint ? reg.fingerprint.slice(0, 16) + "…" : "n/a"}</b></li>
              <li><span>分层计数</span><b>{(reg.layers || []).map((l) => l.id + " " + l.count).join(" · ")}</b></li>
              <li><span>重建命令</span><b className={kit.mono}>node scripts/guard-registry.cjs --write</b></li>
            </ul>
            <Note tone="warn">快照生成后如守门脚本有新增/删除，本页数字与真实源码会短期不一致；需重生成 registry 才会更新。</Note>
          </BentoCard>

          <BentoCard span={12} title="口径与缺口">
            <ul className={kit.kv}>
              <li><span>触发数 / 最近触发</span><b>n/a —— registry 只登记守卫定义，无运行时触发计数（需真实运行数据/埋点）；本批不伪造「最近触发」。</b></li>
              <li><span>快照时效</span><b>快照生成于 {fmtTime(reg.generatedAt)}；与源码一致性由 fingerprint 校验（node scripts/guard-registry.cjs --check）。</b></li>
              <li><span>只读</span><b>0.5.1 无写控件；守卫详情（/api/guards/&lt;id&gt;）本批不展开（列表已含触发/源码/复算命令）。</b></li>
            </ul>
            <Note>相关视图：<a className={kit.link} href="/system/access-log">访问日志</a> · <a className={kit.link} href="/system/observability">可观测性</a></Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}
