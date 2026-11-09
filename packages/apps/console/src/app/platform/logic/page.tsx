"use client";
// 2026-11-04 · P1 试点页呈现层改造（ord-20261104-032）· 平台配置 /platform/logic（模板 D 配置）
// ---------------------------------------------------------------------------
// 本批只做「结构 + 四态」：左列 + 右详情、约束条、四态齐全；**不加任何写操作**
//   （before/after 同屏 + 二次确认 + 审计留痕属另一个批次，见文末 TODO）。
// 取数代码 0 改动：仍是 useEffect + fetch('/api/platform-logic?_gf=…')，端点/参数/缓存策略原样。
// 四态落点：
//   · 加载：左列 + 右详情骨架（保持栅格形状，不出现空白页）
//   · 错误：ErrorBlock（接口 + 状态码 + 重试）
//   · 空  ：该分组暂无配置项（写清"由谁注册"）
//   · 无权限：只读态 + 申请入口（说明缺 config.write / 读权限点）
import { useEffect, useState } from "react";
import { Alert } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
import TableCopyButton from "@/components/TableCopyButton";
import { DataTable, StateBlock, ErrorBlock, PageHeader, PageTitle, Pill } from "@/components/ui";
import { t } from "@/i18n";
import styles from "./page.module.css";

// 平台逻辑总览 (2026-09-10): 页面直接读取 docs/platform-logic/*.md -> 文档与页面同一来源, 不会漂移。
interface Section { heading: string; lines: string[] }
interface Domain { key: string; title: string; file: string; updatedAt: string; sections: Section[] }
interface Data { ok: boolean; dir: string; domains: Domain[]; index: string; inventory: Array<{ name: string; dir: string; updatedAt: string; sizeKb: number }>; error?: string }
interface InvRow { name: string; dir: string; updatedAt: string; sizeKb: number }
/** 变更记录的一行（模板 D ⑥：时间 / 操作者 / 配置项 / before / after / 结果）。
 *  当前无审计接口 —— 表结构与列先就位，rows 恒为空由 empty 写清触发条件，不编造记录。 */
interface ChangeRow { at: string; who: string; key: string; before: string; after: string; result: string }

const fmt = (v?: string) => (v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "-");

// 2026-11-09 · 0.4.39-04 CLS / 布局修复：
// 实测 /api/platform-logic 当前下发 354 个域，左栏一次渲染 354 个按钮 = 37893px，
// 整页 scrollHeight 1270 -> 38924px —— 这是布局 bug（不是单纯 CLS）。
// 对策：① 左栏限高 + 内部滚动；② 右栏同高（文档正文内部滚动），栅格高度恒定 -> 数据到达前后不位移；
//       ③ 域列表/文档清单首屏只渲染前 N 项（桌面 20 / 移动端 10），超出给「显示全部」按钮。
const N_DESKTOP = 20;
const N_MOBILE = 10;

/** 移动端判定必须放在 effect 里（matchMedia）后再切：渲染期直接读 window 会与 SSR 不一致 -> hydration mismatch。
 *  断点 640px 与 page.module.css 的 @media (max-width: 640px) 同值。 */
function useMobileQuery() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => setMobile(mq.matches);
    apply();
    if (mq.addEventListener) {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
    // 老 Safari 只有 addListener / removeListener（类型里没有，按可选调用兜底）
    (mq as any).addListener?.(apply);
    return () => (mq as any).removeListener?.(apply);
  }, []);
  return mobile;
}

/** 无权限的唯一判定口：401/403 或后端文案含「无权限 / 未授权」。只决定渲染哪个四态，不吞错误。 */
const FORBIDDEN_RE = /401|403|无权限|未授权|unauthori[sz]ed|forbidden/i;
const isForbidden = (msg: string) => FORBIDDEN_RE.test(msg);

export default function PlatformLogicPage() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [active, setActive] = useState("flywheel");
  const [showIndex, setShowIndex] = useState(false);
  // 0.4.39-04 CLS：首屏渲染窗口（域列表 / 文档清单），数据/顺序/文案不变。
  const isMobile = useMobileQuery();
  const pageSize = isMobile ? N_MOBILE : N_DESKTOP;
  const [showAllDomains, setShowAllDomains] = useState(false);
  const [showAllInv, setShowAllInv] = useState(false);

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

  const domains = d?.domains ?? [];
  const dom = domains.find((x) => x.key === active) || domains[0];
  const inv: InvRow[] = d?.inventory ?? [];
  const loading = !d && !err;
  const forbidden = isForbidden(String(err || ""));

  const visibleDomains = showAllDomains ? domains : domains.slice(0, pageSize);
  const hiddenDomains = domains.length - visibleDomains.length;
  const visibleInv = showAllInv ? inv : inv.slice(0, pageSize);
  const hiddenInv = inv.length - visibleInv.length;

  // 当前高亮的域若不在前 N 个里（刷新后顺序变化 / 断点切换），自动展开，避免右侧有内容而左栏找不到选中项。
  useEffect(() => {
    if (!dom) return;
    const idx = domains.findIndex((x) => x.key === dom.key);
    if (idx >= pageSize && !showAllDomains) setShowAllDomains(true);
  }, [dom, domains, pageSize, showAllDomains]);

  // 文档行渲染：> 引用行变暗；表格行用等宽（原来是内联样式，现已收进 page.module.css）
  const renderLines = (lines: string[]) =>
    lines.filter((l) => l.trim() !== "").map((l, i) => {
      const isTable = l.trim().startsWith("|");
      const cls = [styles.docLine, l.startsWith(">") ? styles.docLineQuote : "", isTable ? styles.docLineTable : ""].filter(Boolean).join(" ");
      return (<div key={i} className={cls}>{l}</div>);
    });

  return (
    <div className="layout"><main className="main">
      <div className="breadcrumb"><span className={styles.bcDim}>平台</span><span className="sep">/</span><span className="current">逻辑总览</span></div>
      <PageHeader>
        <PageTitle>平台逻辑总览（现状型文档 · 页面与文档同源）</PageTitle>
        <div className="page-subtitle">
          数据来自 <code>{d?.dir || "docs/platform-logic"}</code> —— 每个域一份 living 文档, 段落固定(设计意图/输入/分类结构化/过滤守卫/质量打分/校验自检/迭代节奏/关键位置/已知缺口)。改文档即改页面。
        </div>
        <div className={styles.headerTags}>
          {/* 模板 D 要求页头有「可写」chip；但本页**当前没有任何写通路**（写流程属另一批），
              写一个「可写」会让人以为可以改值 —— 按诚实优先拆成两个 chip，见报告「与 PILOT 的差异」。 */}
          <Pill tone="mute">只读 · 当前</Pill>
          <Pill tone="warn">可写 · 写流程未上线</Pill>
          <Pill tone="info">{d ? "共 " + domains.length + " 个域" : "加载中…"}</Pill>
        </div>
      </PageHeader>

      {/* 约束条（三闸门）常驻：模板 D ②。写死三条，不随数据变化、不隐藏。 */}
      <Alert
        className={styles.gateBar}
        type="warning"
        showIcon
        title="可写页（全站仅两处）：写 = 前后对比 + 二次确认 + 审计"
        description={<>每次写操作必须：① 变更前后对比 ② 二次确认 ③ 写一条 audit（who / when / what / before / after）。本页当前只读；写通路属另一批，不在此批实现。</>}
      />

      {forbidden ? (
        // 四态 · 无权限：只读态 + 申请入口（模板 D 要求说明缺 config.write）
        <StateBlock
          title="无权限访问"
          desc={<>
            读：缺少平台配置的只读权限点 <code>platform.logic</code>；写：缺少 <code>config.write</code>（全站仅平台配置与平台授权两处可写）。<br />
            找平台管理员 / devops 值班开通；也可在「权限管理」页发起授权申请。
          </>}
          action={<a className="btn btn-sm" href="/system/permissions">申请授权</a>}
        />
      ) : err ? (
        // 四态 · 错误：接口 + 状态码 + 重试
        <div className="panel">
          <ErrorBlock message={String(err).slice(0, 200)} onRetry={() => window.location.reload()} />
        </div>
      ) : (
        <>
          <div className={styles.cfgGrid}>
            <aside className={styles.cfgLeft} aria-label="逻辑域列表">
              <div className={styles.cfgLeftHead}>{loading ? "逻辑域 · 加载中…" : "逻辑域 · 共 " + domains.length + " 个"}</div>
              {loading ? (
                <div className={styles.leftSkeleton}><StateBlock loading rows={6} /></div>
              ) : (
                <nav className={styles.domainList}>
                  {visibleDomains.map((x) => {
                    const on = x.key === dom?.key;
                    return (
                      <button
                        key={x.key}
                        type="button"
                        className={styles.domainItem + (on ? " " + styles.domainItemOn : "")}
                        aria-current={on ? "true" : undefined}
                        onClick={() => setActive(x.key)}
                      >
                        <span className={styles.domainName}>{x.title}</span>
                        <span className={styles.domainFile}>{x.file} · 更新 {fmt(x.updatedAt)}</span>
                      </button>
                    );
                  })}
                  {domains.length === 0 && (
                    <StateBlock
                      title="该分组暂无配置项"
                      desc={<>触发条件：<code>docs/platform-logic/</code> 下没有任何域文档。<br />由文档注册：新增一个域 = 加一份 living 文档（本页与文档同源）。</>}
                    />
                  )}
                </nav>
              )}
              {/* 0.4.39-04：354 个域首屏只渲染前 N 个，点按钮才全渲染（文案走 i18n）。 */}
              {hiddenDomains > 0 ? (
                <div className={styles.moreBar}>
                  <button type="button" className="btn btn-sm" onClick={() => setShowAllDomains(true)}>
                    {t("logic.domains.showAll", { n: domains.length })}
                  </button>
                </div>
              ) : null}
            </aside>

            <div className={styles.cfgRight}>
              {loading ? (
                <div className="panel"><StateBlock loading rows={8} /></div>
              ) : dom ? (
                <div className="panel">
                  <div className="panel-header">
                    <span className="panel-title">{dom.title}</span>
                    <span className={styles.panelNote}>{dom.file} · 文档更新 {fmt(dom.updatedAt)}</span>
                  </div>
                  {dom.sections.map((s, i) => (
                    <details key={i} open={i === 0} className={styles.section}>
                      <summary className={styles.sectionSummary}>
                        {s.heading}{" "}
                        <span className={styles.sectionCount}>（{s.lines.length} 行，点击展开/收起）</span>
                      </summary>
                      {renderLines(s.lines)}
                    </details>
                  ))}
                  {/* 模板 D ④⑤（变更预览 before/after + 二次确认）本批**不实现** —— 不真的加写操作。
                      TODO(write-flow 批次)：编辑态出现 before/after 同屏；二次确认弹窗含「已知晓影响」勾选 + 审计提示；
                      未填变更原因不可提交。数据卡 5 缺口：配置项 diff 与审计的关联 ID（devops 2026-11-10 前补）。 */}
                </div>
              ) : (
                <div className="panel">
                  <StateBlock
                    title="该分组暂无配置项"
                    desc={<>触发条件：<code>docs/platform-logic/</code> 未注册该域文档。<br />由文档注册；新增域请加一份 living 文档。</>}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">文档结构与清单</span>
              <span className={styles.panelNote}>共 {inv.length} 篇 docs/*.md</span>
              <button className="ui-btn" onClick={() => setShowIndex((v) => !v)}>
                {showIndex ? "隐藏文档索引/清单" : "文档索引 + docs/ 清单"}
              </button>
            </div>
            {showIndex && (
              <>
                <TableCopyButton />
                <DataTable
                  rows={visibleInv}
                  rowKey={(f) => f.dir + f.name}
                  empty={{ title: "清单为空", desc: "触发条件：/api/platform-logic 的 inventory 为空（docs/ 未扫描到 .md）。" }}
                  columns={[
                    { key: "name", title: "文件", render: (f) => <span className="mono nowrap">{f.name}</span> },
                    { key: "dir", title: "目录", render: (f) => <span className={styles.panelNote}>{f.dir}</span> },
                    { key: "sizeKb", title: "KB", align: "right", width: "88px" },
                    { key: "updatedAt", title: "修改时间", render: (f) => <span className="mono nowrap">{fmt(f.updatedAt)}</span> },
                  ]}
                />
                {/* 0.4.39-04：文档清单 1224 篇，首屏只渲染前 N 篇（点了才全渲染）。 */}
                {hiddenInv > 0 ? (
                  <div className={styles.moreBar}>
                    <button type="button" className="btn btn-sm" onClick={() => setShowAllInv(true)}>
                      {t("logic.inventory.showAll", { n: inv.length })}
                    </button>
                  </div>
                ) : null}
              </>
            )}
            <div className={styles.panelNote}>
              结构约定: <b>docs/platform-logic/</b> = 现状型(本页渲染); <b>docs/*.md</b> = 事件型(plan/diagnosis/report, 带日期)。
            </div>
          </div>

          <div className="panel">
            <div className="panel-header"><span className="panel-title">变更记录（最近 10 条）</span><span className={styles.panelNote}>模板 D ⑥ · 待数据卡补</span></div>
            {/* 模板 D ⑥ 变更记录 = 时间 / 操作者 / 配置项 / before / after / 结果。
                本页无审计接口（本批不改取数），故只占位并写清缺什么，不编造记录。 */}
            <DataTable
              rows={[] as ChangeRow[]}
              rowKey={(r) => r.at + r.key}
              empty={{
                title: "变更记录未接入",
                desc: "触发条件：本页未接审计接口（本批不改取数）。审计记录尚未接入；全量记录可在审计模块查看。",
              }}
              columns={[
                { key: "at", title: "时间", width: "180px" },
                { key: "who", title: "操作者", width: "140px" },
                { key: "key", title: "配置项" },
                { key: "before", title: "变更前" },
                { key: "after", title: "变更后" },
                { key: "result", title: "结果", width: "110px" },
              ]}
            />
          </div>

          <div className="panel">
            <div className="panel-header"><span className="panel-title">相关运行面入口</span></div>
            <div className={styles.linkList}>
              · 飞轮看板 <a href="/flywheel">/flywheel</a> · 任务 <a href="/flywheel/tasks">/flywheel/tasks</a> · 反思 <a href="/flywheel/reflections">/flywheel/reflections</a> · <a href="/flywheel/flow">运转动态图</a><br />
              · 质量自检: <code>GET /api/v1/flywheel/quality-audit</code>（每日 00:20 自动, 页面见 flywheel/flow 顶部）<br />
              · 证据报告: <code>docs/evidence-self-proof-report.md</code>（A-J 维度自证 + 处置附录 L）<br />
              · 接口文档: <code>docs/platform-logic/*.md</code> 各域"关键位置"段落列出代码/接口/表
            </div>
          </div>
        </>
      )}
    </main></div>
  );
}
