"use client";
import LoadingBlock from "@/components/LoadingBlock";
import Link from "next/link";
// 守门规则管理页面 (#3, 2026-09-24)
// 上一版(dc4c2e4)是只读总表; 本版加:①左侧"分层目录"(替代顶部 KPI, 与列表共存)
//                    ②行点击 → 详情抽屉(从 service-check 拉最近一次跑结果 / FlywheelEvent 关联 / git 出处)
//                    ③保留 URL ?open=<id>, 可深链可刷新。
// SSOT 不变 (scripts/guard-registry.cjs 抽取); 详情数据全在 BFF /api/guards/[id] 拼装, console 不重算。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 手写 .tbl 表 → 白名单 DataTable。
//   列/字段/文案不变；层色（L1–L6）从 JS 拼 color-mix 改成 [data-layer] 属性选择器（算式逐字一致）。
//   DataTable 没有 onRow，所以"整行可点 → 抽屉"改在页面层用事件委托实现（点链接/按钮/输入不触发）。
//   取数（/guard-registry.json）与 ?layer=/?q=/?open= 的 URL 语义一字未改。
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import KPICard from "@/components/KPICard";
import GuardDetailDrawer from "@/components/guards/GuardDetailDrawer";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface Guard {
  id: string; layer: string; name: string; file: string; line: number;
  trigger: string; action: string; note: string; recompute: string;
}
interface Layer { id: string; name: string; desc: string; trigger: string; count: number }
interface Registry {
  generatedAt: string; fingerprint: string; description: string;
  totals: { all: number; byLayer: Record<string, number> };
  layers: Layer[]; guards: Guard[];
}

// 2026-10-13 round 76-CM: 层色**原样当文字色**在浅色底上对比不足 —— 对比度扫描实测 /system/guards
//   worst=2.15(需 4.5), 罪魁是 L2 = --layer-l2 = #f59e0b(琥珀) 压在 13% 同色淡底上。
//   修法: 文字色改为**层色向当前主题文字色混合** —— 浅色下自动变暗、暗色下自动变亮,
//   既保留"第几层"的色相身份, 又随主题自适应(不用为三主题各写一套值)。
// 2026-11-05 P2：这两个算式已原样搬进 page.module.css 的 [data-layer] 规则（.layerBadge / .navBtn）。

export default function GuardsPage() {
  const [reg, setReg] = useState<Registry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [layer, setLayer] = useState<string>("ALL");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // 2026-10-19 B6(方案 L2-3): 修前**一次性渲染全部 425 行**, 页面实测 **30.2 屏** ✗ ——
  //   管理员要翻 30 屏才知道有哪些规则。改为**增量显示**: 首屏 20 行 + 「显示更多」。
  //   (页内已有 层/搜索 过滤与抽屉详情 ✓, 这里只补"分批呈现"这一环)
  const [shown, setShown] = useState(20);
  useEffect(() => { setShown(20); }, [layer, q]);

  // URL 状态同步: ?open=<id> 深链可分享
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    const oid = u.searchParams.get("open");
    if (oid) setOpenId(oid);
    const lyr = u.searchParams.get("layer");
    if (lyr) setLayer(lyr);
    const k = u.searchParams.get("q");
    if (k) setQ(k);
  }, []);

  // 2026-10-16（人类决策 ②，round 77-I）: 「复算命令」列**默认隐藏**, 由用户按需显示 ✓
  //   与页头/页脚的折叠区同一意图: 默认视图只讲业务语言, 可执行细节一键可取 ✓。
  const [showCmd, setShowCmd] = useState(false);

  function updateUrl(next: { open?: string | null; layer?: string; q?: string }) {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (next.open !== undefined) {
      if (next.open) u.searchParams.set("open", next.open);
      else u.searchParams.delete("open");
    }
    if (next.layer !== undefined) {
      if (next.layer && next.layer !== "ALL") u.searchParams.set("layer", next.layer);
      else u.searchParams.delete("layer");
    }
    if (next.q !== undefined) {
      if (next.q) u.searchParams.set("q", next.q);
      else u.searchParams.delete("q");
    }
    window.history.replaceState(null, "", u.toString());
  }

  useEffect(() => {
    fetch("/guard-registry.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("加载失败 (状态 " + r.status + ")"))))
      .then(setReg)
      .catch((e) => setErr(String(e)));
  }, []);

  const guards = useMemo(() => {
    if (!reg) return [];
    const kw = q.trim().toLowerCase();
    return reg.guards.filter((g) =>
      (layer === "ALL" || g.layer === layer) &&
      (!kw || (g.name + " " + g.note + " " + g.file + " " + g.trigger + " " + g.id).toLowerCase().includes(kw))
    );
  }, [reg, layer, q]);

  function setLayerAndUrl(v: string) {
    setLayer(v);
    updateUrl({ layer: v });
  }

  function setQAndUrl(v: string) {
    setQ(v);
    updateUrl({ q: v });
  }

  function openDetail(id: string) {
    setOpenId(id);
    updateUrl({ open: id });
  }

  function closeDetail() {
    setOpenId(null);
    updateUrl({ open: null });
  }

  // 整行可点 → 抽屉（白名单 DataTable 没有 onRow，这里在页面层做事件委托；
  // 点在链接/按钮/输入框上不触发 —— 行内次操作独立生效）
  const visible = guards.slice(0, shown);
  function onTableClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest("a,button,input,select,textarea,label,[role=menu]")) return;
    const tr = target.closest("tbody tr") as HTMLTableRowElement | null;
    if (!tr || tr.classList.contains("dt-state-row")) return;
    const body = tr.parentElement;
    if (!body) return;
    const i = Array.prototype.indexOf.call(body.children, tr);
    const g = visible[i];
    if (g && g.id) openDetail(g.id);
  }

  const columns: DataColumn<Guard>[] = [
    {
      key: "layer",
      title: "层",
      width: 50,
      render: (g) => (
        <span className={"badge nowrap " + styles.layerBadge} data-layer={g.layer}>{g.layer}</span>
      ),
    },
    {
      key: "name",
      title: "名称 / 说明",
      render: (g) => (
        <>
          <b className={styles.nameB}>{g.name}</b>
          {g.note && <div className={styles.note}>{g.note}</div>}
        </>
      ),
    },
    { key: "trigger", title: "触发", width: 110, render: (g) => <span className={"nowrap " + styles.cellXs}>{g.trigger}</span> },
    {
      key: "file",
      title: "源码位置",
      width: 200,
      render: (g) => <span className={"nowrap " + styles.cellXsMono}>{g.file}:{g.line}</span>,
    },
    ...(showCmd
      ? [{
          key: "recompute",
          title: "复算命令",
          render: (g: Guard) => <span className={styles.cmdCell}>{g.recompute}</span>,
        } as DataColumn<Guard>]
      : []),
  ];

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb"><span className={styles.crumbDim}>平台管理</span><span className="sep">/</span><span className="current">守门规则管理</span></div>
      <PageHeader>
        <PageTitle>守门规则管理</PageTitle>
        <div className="page-subtitle">
          平台全部守门机制的单一入口 · 由源码自动抽取(SSOT), 不手工维护 · 防漂移由守门注册表自动校验 · 行点击看详情
        </div>
      </PageHeader>

      {err && <div className="panel"><div className="panel-header"><span className={"panel-title " + styles.critTitle}>总表加载失败</span></div><div className={styles.pad3}>{err} — 请先重建总表（命令见下方「如何复算 / 防漂移」）</div></div>}

      {!reg && !err && <div className="panel"><div className={styles.pad3}><LoadingBlock lines={3} /></div></div>}

      {reg && (<>
        {/* KPI 行 */}
        <div className="kpi-grid">
          <KPICard label="守门总数" value={reg.totals.all.toString()} />
          <KPICard label="覆盖层数" value={reg.layers.length.toString()} />
          <KPICard label="其中提交前(L1)" value={(reg.totals.byLayer.L1 ?? 0).toString()} />
          <KPICard label="其中巡检/判据" value={((reg.totals.byLayer.L2 ?? 0) + (reg.totals.byLayer.L3 ?? 0)).toString()} />
        </div>

        {/* 2026-10-19 B5(方案 L3-2): 修前本页正文 **0 条出链** ✗。页面本来就支持 `?layer=` 过滤
            (updateUrl 里已实现 ✓), 但**没有可分享的入口** —— 这里把"只看某一层"做成真链接。 */}
        <div className={"tiny " + styles.layerLinks}>
          <span>按层看：</span>
          <Link href="/system/guards?layer=L1" onClick={() => setLayerAndUrl("L1")}>提交前 L1 →</Link>
          <Link href="/system/guards?layer=L2" onClick={() => setLayerAndUrl("L2")}>巡检 L2 →</Link>
          <Link href="/system/guards?layer=L3" onClick={() => setLayerAndUrl("L3")}>判据 L3 →</Link>
          <Link href="/system/guards" onClick={() => setLayerAndUrl("ALL")}>全部 →</Link>
        </div>

        <div className={styles.split}>
          {/* 左侧: 目录(分层) */}
          <div className={"panel " + styles.fitContent}>
            <div className="panel-header"><span className="panel-title">分层目录</span></div>
            <div>
              <button type="button"
                onClick={() => setLayerAndUrl("ALL")}
                className={styles.navBtn + " " + styles.navBtnAll}
                data-active={layer === "ALL" ? "true" : undefined}>
                <b>ALL</b> <span className={styles.countRight}>{reg.totals.all}</span>
              </button>
              {reg.layers.map((l) => (
                <button type="button" key={l.id}
                  onClick={() => setLayerAndUrl(l.id)}
                  title={l.desc}
                  className={styles.navBtn}
                  data-layer={l.id}
                  data-active={layer === l.id ? "true" : undefined}>
                  <span className={"badge " + styles.layerBadge + " " + styles.navBadge} data-layer={l.id}>{l.id}</span>
                  <b className={styles.navName}>{l.name}</b>
                  <span className={styles.countRight}>{l.count}</span>
                  <div className={styles.navTrigger}>{l.trigger}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 右侧: 逐条清单 */}
          <div>
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">逐条清单 {guards.length !== reg.totals.all ? `（筛选 ${guards.length} / ${reg.totals.all}）` : `（${reg.totals.all}）`}</span>
                <span className={styles.headTools}>
                  <input className={"input " + styles.w220} placeholder="搜索 名称 / 说明 / 路径…" value={q} onChange={(e) => setQAndUrl(e.target.value)} />
                  <label className={"tiny " + styles.showCmdLabel}>
                    <input type="checkbox" checked={showCmd} onChange={(e) => setShowCmd(e.target.checked)} />
                    显示复算命令
                  </label>
                </span>
              </div>
              <div className={styles.genRow}>
                生成于 {reg.generatedAt.replace("T", " ").slice(0, 19)} · fingerprint <span className="mono">{reg.fingerprint.slice(0, 12)}…</span>
              </div>
              <TableCopyButton />
              <div className={styles.clickable} onClick={onTableClick}>
                <DataTable
                  columns={columns}
                  rows={visible}
                  rowKey={(g) => g.id}
                  empty={{ title: "无匹配守门。" }}
                />
              </div>
              {/* 2026-10-19 B6: 425 行全渲染 -> 增量显示; 首屏 20 行, 之后每次 +40 ✓ */}
              {guards.length > shown && (
                <div className={styles.moreBar}>
                  <button className="btn" onClick={() => setShown((v) => v + 40)}>显示更多（已显示 {shown} / 共 {guards.length} 条）</button>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-header"><span className="panel-title">如何复算 / 防漂移</span></div>
              <div className={styles.howBody}>
                <div>总表由源码投影, <b>任何守门新增/删除</b>都会改变 fingerprint:</div>
                {/* 2026-10-16（人类决策 ②，round 77-H）: 命令与内部路径**默认收进折叠区** ——
                    与 /agents/approvals、/agents/onboard 的既有做法**同一模式** ✓,
                    正文只说业务语言, 但**不删掉可执行细节**(装机/运维仍要复制) ✓。 */}
                <details className={styles.details}>
                  <summary className={styles.summary}>查看命令</summary>
                  <pre className={styles.pre}>{`$ node scripts/guard-registry.cjs --check   # 漂移则退出码 1
$ node scripts/guard-registry.cjs --write   # 源码变更后重建

# 人读总表: docs/platform-logic/GUARD-REGISTRY.md`}</pre>
                </details>
              </div>
            </div>
          </div>
        </div>
      </>)}

      <GuardDetailDrawer id={openId} open={!!openId} onClose={closeDetail} />
    </main></div>
  );
}
