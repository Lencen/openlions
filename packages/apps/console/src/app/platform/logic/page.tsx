"use client";
import { useEffect, useState } from "react";
import { Alert, Select } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
import TableCopyButton from "@/components/TableCopyButton";

// 平台逻辑总览 (2026-09-10): 页面直接读取 docs/platform-logic/*.md -> 文档与页面同一来源, 不会漂移。
interface Section { heading: string; lines: string[] }
interface Domain { key: string; title: string; file: string; updatedAt: string; sections: Section[] }
interface Data { ok: boolean; dir: string; domains: Domain[]; index: string; inventory: Array<{ name: string; dir: string; updatedAt: string; sizeKb: number }>; error?: string }

const fmt = (v?: string) => (v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "-");

export default function PlatformLogicPage() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [active, setActive] = useState("flywheel");
  const [showIndex, setShowIndex] = useState(false);

  // 2026-10-13 round 76-DL: 接入全局刷新(本页只挂载拉一次)。
  const gf = useGlobalNonce();
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/platform-logic?_gf=${gf}`, { cache: "no-store" });
        const j = await r.json();
        if (j.error) setErr(j.error); else setD(j);
      } catch (e: any) { setErr(e.message); }
    })();
  }, [gf]);

  const dom = d?.domains.find((x) => x.key === active) || d?.domains[0];
  const renderLines = (lines: string[]) =>
    lines.filter((l) => l.trim() !== "").map((l, i) => {
      const h = l.match(/^(>|\|\s*-\s*|\d+\.\s*)/);
      const isTable = l.trim().startsWith("|");
      return (
        <div key={i} style={{ fontSize: "var(--fs-base)", lineHeight: 1.75, color: l.startsWith(">") ? "var(--text-dim)" : "inherit", whiteSpace: "pre-wrap", fontFamily: isTable ? "monospace" : "inherit", overflowX: "auto" }}>
          {l}
        </div>
      );
    });

  return (
    <div className="layout"><main className="main">
      <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>平台</span><span className="sep">/</span><span className="current">逻辑总览</span></div>
      <div className="page-header">
        <div className="page-title">平台逻辑总览（现状型文档 · 页面与文档同源）</div>
        <div className="page-subtitle">
          数据来自 <code>{d?.dir || "docs/platform-logic"}</code> —— 每个域一份 living 文档, 段落固定(设计意图/输入/分类结构化/过滤守卫/质量打分/校验自检/迭代节奏/关键位置/已知缺口)。改文档即改页面。
        </div>
      </div>
      {err && <div style={{ marginBottom: "var(--sp-3)" }}><Alert type="error" message="平台逻辑加载失败" description={String(err).slice(0, 200)} /></div>}

      <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", marginBottom: "var(--sp-3)", alignItems: "center" }}>
        <Select
          showSearch
          placeholder="选择逻辑域"
          style={{ minWidth: 320 }}
          value={active}
          onChange={(v: any) => setActive(String(v))}
          options={(d?.domains || []).map((x) => ({ value: x.key, label: x.title }))}
        />
        {/* 2026-10-13 round 76-CW: 补加载态 —— 原来首帧会显示"共 0 个域", 那是**假计数**(与真的 0 个域无法区分)。 */}
        <span className="tiny" style={{ color: "var(--text-dim)" }}>{d ? "共 " + (d.domains?.length ?? 0) + " 个域" : "加载中…"}</span>
        <button className="ui-btn" style={{ fontSize: "var(--fs-base)", marginLeft: "auto" }} onClick={() => setShowIndex((v) => !v)}>
          {showIndex ? "隐藏文档索引/清单" : "文档索引 + docs/ 清单"}
        </button>
      </div>

      {showIndex && (
        <div className="panel" style={{ marginBottom: "var(--sp-3)" }}>
          <div className="panel-header"><span className="panel-title">文档结构与清单</span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>共 {d?.inventory?.length ?? 0} 篇 docs/*.md</span>
          </div>
          <div style={{ maxHeight: 260, overflow: "auto" }}>
            <TableCopyButton />
            <table className="tbl" style={{ fontSize: "var(--fs-sm)" }}>
              <thead><tr><th>文件</th><th>目录</th><th style={{ textAlign: "right" }}>KB</th><th>修改时间</th></tr></thead>
              <tbody>
                {(d?.inventory || []).map((f) => (
                  <tr key={f.dir + f.name}>
                    <td className="mono nowrap">{f.name}</td>
                    <td style={{ color: "var(--text-dim)" }}>{f.dir}</td>
                    <td style={{ textAlign: "right" }}>{f.sizeKb}</td>
                    <td className="nowrap mono" style={{ color: "var(--text-dim)" }}>{fmt(f.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: "var(--sp-2)", fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>
            结构约定: <b>docs/platform-logic/</b> = 现状型(本页渲染); <b>docs/*.md</b> = 事件型(plan/diagnosis/report, 带日期)。
          </div>
        </div>
      )}

      {dom && (
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">{dom.title}</span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{dom.file} · 文档更新 {fmt(dom.updatedAt)}</span>
          </div>
          {dom.sections.map((s, i) => (
              <details key={i} open={i === 0} style={{ marginBottom: "var(--sp-3-5)" }}>
                <summary style={{ fontWeight: 700, fontSize: "var(--fs-md)", color: "var(--primary)", cursor: "pointer", marginBottom: "var(--sp-1)" }}>
                  {s.heading}{" "}
                  <span style={{ fontWeight: 400, fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>（{s.lines.length} 行，点击展开/收起）</span>
                </summary>
                {renderLines(s.lines)}
              </details>
            ))}
        </div>
      )}

      <div className="panel" style={{ marginTop: "var(--sp-3)" }}>
        <div className="panel-header"><span className="panel-title">相关运行面入口</span></div>
        <div style={{ fontSize: "var(--fs-base)", lineHeight: 1.9 }}>
          · 飞轮看板 <a href="/flywheel">/flywheel</a> · 任务 <a href="/flywheel/tasks">/flywheel/tasks</a> · 反思 <a href="/flywheel/reflections">/flywheel/reflections</a> · <a href="/flywheel/flow">运转动态图</a><br />
          · 质量自检: <code>GET /api/v1/flywheel/quality-audit</code>（每日 00:20 自动, 页面见 flywheel/flow 顶部）<br />
          · 证据报告: <code>docs/evidence-self-proof-report.md</code>（A-J 维度自证 + 处置附录 L）<br />
          · 接口文档: <code>docs/platform-logic/*.md</code> 各域"关键位置"段落列出代码/接口/表
        </div>
      </div>
    </main></div>
  );
}
