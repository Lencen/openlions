"use client";
import { interactiveProps } from "@/components/a11y";
import LoadingBlock from "@/components/LoadingBlock";
import Link from "next/link";
// 守门规则管理页面 (#3, 2026-09-24)
// 上一版(dc4c2e4)是只读总表; 本版加:①左侧"分层目录"(替代顶部 KPI, 与列表共存)
//                    ②行点击 → 详情抽屉(从 service-check 拉最近一次跑结果 / FlywheelEvent 关联 / git 出处)
//                    ③保留 URL ?open=<id>, 可深链可刷新。
// SSOT 不变 (scripts/guard-registry.cjs 抽取); 详情数据全在 BFF /api/guards/[id] 拼装, console 不重算。
import { useEffect, useMemo, useState } from "react";
import KPICard from "@/components/KPICard";
import GuardDetailDrawer from "@/components/guards/GuardDetailDrawer";
import TableCopyButton from "@/components/TableCopyButton";

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

const LAYER_COLOR: Record<string, string> = {
  L1: "var(--layer-l1)", L2: "var(--layer-l2)", L3: "var(--layer-l3)", L4: "var(--layer-l4)", L5: "var(--layer-l5)", L6: "var(--layer-l6)",
};
// 2026-10-13 round 76-S: 原来用 LAYER_COLOR[id] + "22" 追加 alpha —— 值换成 var() 后不再可行, 改用 color-mix。
const layerBg = (id: string) => "color-mix(in srgb, " + LAYER_COLOR[id] + " 13%, transparent)";
// 2026-10-13 round 76-CM: 层色**原样当文字色**在浅色底上对比不足 —— 对比度扫描实测 /system/guards
//   worst=2.15(需 4.5), 罪魁是 L2 = --layer-l2 = #f59e0b(琥珀) 压在 13% 同色淡底上。
//   修法: 文字色改为**层色向当前主题文字色混合** —— 浅色下自动变暗、暗色下自动变亮,
//   既保留"第几层"的色相身份, 又随主题自适应(不用为三主题各写一套值)。
const layerInk = (id: string) => "color-mix(in srgb, " + LAYER_COLOR[id] + " 45%, var(--text))";

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

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>平台管理</span><span className="sep">/</span><span className="current">守门规则管理</span></div>
      <div className="page-header">
        <div className="page-title">守门规则管理</div>
        <div className="page-subtitle">
          平台全部守门机制的单一入口 · 由源码自动抽取(SSOT), 不手工维护 · 防漂移由守门注册表自动校验 · 行点击看详情
        </div>
      </div>

      {err && <div className="panel"><div className="panel-header"><span className="panel-title" style={{ color: "var(--status-crit)" }}>总表加载失败</span></div><div style={{ padding: "var(--sp-3)" }}>{err} — 请先重建总表（命令见下方「如何复算 / 防漂移」）</div></div>}

      {!reg && !err && <div className="panel"><div style={{ padding: "var(--sp-3)" }}><LoadingBlock lines={3} /></div></div>}

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
        <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginBottom: "var(--sp-3)" }}>
          <span>按层看：</span>
          <Link href="/system/guards?layer=L1" onClick={() => setLayerAndUrl("L1")}>提交前 L1 →</Link>
          <Link href="/system/guards?layer=L2" onClick={() => setLayerAndUrl("L2")}>巡检 L2 →</Link>
          <Link href="/system/guards?layer=L3" onClick={() => setLayerAndUrl("L3")}>判据 L3 →</Link>
          <Link href="/system/guards" onClick={() => setLayerAndUrl("ALL")}>全部 →</Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "var(--sp-3)", marginTop: "var(--sp-1)" }}>
          {/* 左侧: 目录(分层) */}
          <div className="panel" style={{ height: "fit-content" }}>
            <div className="panel-header"><span className="panel-title">分层目录</span></div>
            <div>
              <button type="button"
                onClick={() => setLayerAndUrl("ALL")}
                style={{
                  width: "100%", textAlign: "left", padding: "var(--sp-2) var(--sp-3)", background: layer === "ALL" ? "var(--primary-dim)" : "transparent",
                  border: 0, borderLeft: layer === "ALL" ? "3px solid var(--primary)" : "3px solid transparent",
                  cursor: "pointer", color: layer === "ALL" ? "var(--text)" : "var(--text-dim)", fontSize: "var(--fs-base)",
                }}>
                <b>ALL</b> <span style={{ float: "right" }}>{reg.totals.all}</span>
              </button>
              {reg.layers.map((l) => (
                <button type="button" key={l.id}
                  onClick={() => setLayerAndUrl(l.id)}
                  title={l.desc}
                  style={{
                    width: "100%", textAlign: "left", padding: "var(--sp-2) var(--sp-3)",
                    background: layer === l.id ? layerBg(l.id) : "transparent",
                    border: 0, borderLeft: layer === l.id ? `3px solid ${LAYER_COLOR[l.id]}` : "3px solid transparent",
                    cursor: "pointer", color: layer === l.id ? layerInk(l.id) : "var(--text-dim)", fontSize: "var(--fs-base)",
                  }}>
                  <span className="badge" style={{ background: layerBg(l.id), color: layerInk(l.id), marginRight: "var(--sp-1-5)" }}>{l.id}</span>
                  <b style={{ fontWeight: 500 }}>{l.name}</b>
                  <span style={{ float: "right" }}>{l.count}</span>
                  <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)", marginTop: "var(--sp-0-5)" }}>{l.trigger}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 右侧: 逐条清单 */}
          <div>
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">逐条清单 {guards.length !== reg.totals.all ? `（筛选 ${guards.length} / ${reg.totals.all}）` : `（${reg.totals.all}）`}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: "var(--sp-1-5)", alignItems: "center" }}>
                  <input className="input" placeholder="搜索 名称 / 说明 / 路径…" value={q} onChange={(e) => setQAndUrl(e.target.value)} style={{ width: 220 }} />
                  <label className="tiny" style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-1)", cursor: "pointer", whiteSpace: "nowrap" }}>
                    <input type="checkbox" checked={showCmd} onChange={(e) => setShowCmd(e.target.checked)} />
                    显示复算命令
                  </label>
                </span>
              </div>
              <div style={{ padding: "var(--sp-1-5)", fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
                生成于 {reg.generatedAt.replace("T", " ").slice(0, 19)} · fingerprint <span className="mono">{reg.fingerprint.slice(0, 12)}…</span>
              </div>
              <TableCopyButton />
              <table className="tbl">
                <thead><tr><th style={{ width: 50 }}>层</th><th>名称 / 说明</th><th style={{ width: 110 }}>触发</th><th style={{ width: 200 }}>源码位置</th>{showCmd && <th>复算命令</th>}</tr></thead>
                <tbody>
                  {guards.slice(0, shown).map((g) => (
                    <tr key={g.id} {...interactiveProps(openId === g.id)} style={{ cursor: "pointer" }} onClick={() => openDetail(g.id)}>
                      <td className="nowrap"><span className="badge" style={{ background: layerBg(g.layer), color: layerInk(g.layer) }}>{g.layer}</span></td>
                      <td><b style={{ fontSize: "var(--fs-base)" }}>{g.name}</b>
                        {g.note && <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)", maxWidth: 420 }}>{g.note}</div>}</td>
                      <td className="nowrap" style={{ fontSize: "var(--fs-xs)" }}>{g.trigger}</td>
                      <td className="nowrap mono" style={{ fontSize: "var(--fs-xs)" }}>{g.file}:{g.line}</td>
                      {showCmd && <td className="mono" style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)", maxWidth: 280, wordBreak: "break-all" }}>{g.recompute}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* 2026-10-19 B6: 425 行全渲染 -> 增量显示; 首屏 20 行, 之后每次 +40 ✓ */}
              {guards.length > shown && (
                <div style={{ padding: "var(--sp-3)", textAlign: "center", borderTop: "1px solid var(--border)" }}>
                  <button className="btn" onClick={() => setShown((v) => v + 40)}>显示更多（已显示 {shown} / 共 {guards.length} 条）</button>
                </div>
              )}
              {guards.length === 0 && <div style={{ padding: "var(--sp-3)", color: "var(--text-dim)" }}>无匹配守门。</div>}
            </div>

            <div className="panel">
              <div className="panel-header"><span className="panel-title">如何复算 / 防漂移</span></div>
              <div style={{ padding: "var(--sp-3)", fontSize: "var(--fs-base)", lineHeight: 1.8 }}>
                <div>总表由源码投影, <b>任何守门新增/删除</b>都会改变 fingerprint:</div>
                {/* 2026-10-16（人类决策 ②，round 77-H）: 命令与内部路径**默认收进折叠区** ——
                    与 /agents/approvals、/agents/onboard 的既有做法**同一模式** ✓,
                    正文只说业务语言, 但**不删掉可执行细节**(装机/运维仍要复制) ✓。 */}
                <details style={{ marginTop: "var(--sp-2)" }}>
                  <summary style={{ cursor: "pointer", fontSize: "var(--fs-sm)" }}>查看命令</summary>
                  <pre style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-2)", borderRadius: "var(--radius-sm)", background: "var(--bg)", overflowX: "auto", margin: "var(--sp-2) 0 0" }}>{`$ node scripts/guard-registry.cjs --check   # 漂移则退出码 1
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
