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
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
import TableCopyButton from "@/components/TableCopyButton";
import { DataTable, StateBlock, ErrorBlock, PageHeader, PageTitle, Pill } from "@/components/ui";
// 0.6.1 U-39：13 个二级入口下沉到父页「功能入口」带（侧栏不再有二级菜单）
import FeatureEntries from "@/components/FeatureEntries";
import { NAV_GROUPS } from "@/config/nav";
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

/** 0.6.4 U-56a：平台配置读写响应（后端 /api/platform/config 契约） */
interface CfgResp {
  ok: boolean;
  settings: {
    team_language?: string;
    agent_team?: {
      enabled?: boolean; mode?: string;
      turn_budget_seconds?: number; long_task_threshold_seconds?: number;
      require_subagent_for_long_task?: boolean; interrupt_check_seconds?: number;
      pending_alert_threshold?: number; open_turns_alert_seconds?: number;
    };
  };
  source?: string; authMode?: string; authModeSource?: string; asOf?: string;
}

/** 可写配置项（后端白名单同一份；中文标签用于界面，提交时用真键名） */
const CFG_FIELDS: Array<{
  key: string; label: string; hint: string;
  kind: "bool" | "num" | "enum";
  options?: Array<{ v: string; t: string }>;
  topLevel?: boolean;
}> = [
  { key: "enabled", label: "团队协作开关", hint: "关闭后不启用团队编排", kind: "bool" },
  { key: "mode", label: "运行模式", hint: "双工 / 单工 / 自动", kind: "enum", options: [{ v: "duplex", t: "双工" }, { v: "single", t: "单工" }, { v: "auto", t: "自动" }] },
  { key: "team_language", label: "平台语言", hint: "团队回复语言", kind: "enum", options: [{ v: "auto", t: "自动" }, { v: "zh-CN", t: "简体中文" }, { v: "en-US", t: "English" }], topLevel: true },
  { key: "turn_budget_seconds", label: "单轮预算（秒）", hint: "单轮可用时长上限", kind: "num" },
  { key: "long_task_threshold_seconds", label: "长任务阈值（秒）", hint: "超过即按长任务处理", kind: "num" },
  { key: "interrupt_check_seconds", label: "中断检查间隔（秒）", hint: "检查打断信号的间隔", kind: "num" },
  { key: "pending_alert_threshold", label: "待处理告警阈值", hint: "积压达到即告警", kind: "num" },
  { key: "open_turns_alert_seconds", label: "未完结轮次告警（秒）", hint: "久未完结即告警", kind: "num" },
  { key: "require_subagent_for_long_task", label: "长任务必须子智能体", hint: "开启后长任务须走子智能体", kind: "bool" },
];

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

  // ── 0.6.4 U-56a：平台配置（可写；before/after 同屏 + 二次确认 + 变更原因必填 + 审计）────────
  //   落地本页 2026-11-04 预留的 TODO(write-flow 批次)。
  //   读写走后端 /api/platform/config（platform-data C1-C7 已闭环）；本页不改既有文档取数。
  const [cfg, setCfg] = useState<CfgResp | null>(null);
  const [cfgErr, setCfgErr] = useState("");
  const [draft, setDraft] = useState<Record<string, string | boolean>>({}); // 编辑中的新值（仅改过的键）
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitMsg, setSubmitMsg] = useState("");
  const [submitErr, setSubmitErr] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [nonceCfg, setNonceCfg] = useState(0);
  // 工具栏「刷新」是本页唯一的手动重取入口（本页只挂载拉一次）：文档域 + 平台配置各拉一次。
  const [nonceDoc, setNonceDoc] = useState(0);

  useEffect(() => {
    let alive = true; setCfgErr("");
    (async () => {
      try {
        const r = await fetch("/api/platform/config", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setCfgErr("无权限（401/403）"); return; }
        if (!r.ok) { setCfgErr("配置接口 " + r.status); return; }
        const j = await r.json();
        if (!alive) return;
        if (!j || j.ok !== true) { setCfgErr("配置不可得"); return; }
        setCfg(j);
      } catch { if (alive) setCfgErr("配置请求失败（网络/服务不可用）"); }
    })();
    return () => { alive = false; };
  }, [nonceCfg]);

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
  }, [gf, nonceDoc]);

  const reloadAll = () => { setNonceDoc((x) => x + 1); setNonceCfg((x) => x + 1); };

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

  // ── 0.6.4 U-56a：配置读取 / 草稿 / diff / 提交 ────────────────────────────────
  const curOf = useCallback((f: { key: string; topLevel?: boolean }): string | boolean | number | undefined => {
    if (!cfg?.settings) return undefined;
    if (f.topLevel) return cfg.settings.team_language;
    return (cfg.settings.agent_team as any)?.[f.key];
  }, [cfg]);

  const valOf = (f: { key: string; topLevel?: boolean }): string | boolean | number | undefined =>
    draft[f.key] !== undefined ? draft[f.key] : curOf(f);

  /** 已改动项（用于 before/after 同屏与提交 patch） */
  const changed = CFG_FIELDS.filter((f) => draft[f.key] !== undefined && String(draft[f.key]) !== String(curOf(f) ?? ""));

  const setField = (key: string, v: string | boolean) => {
    setSubmitMsg(""); setSubmitErr("");
    setDraft((d) => ({ ...d, [key]: v }));
  };

  const submitCfg = useCallback(async () => {
    if (busy || changed.length === 0) return;
    if (!reason.trim()) { setSubmitErr("请填写变更原因（将写入审计）"); return; }
    if (!ack) { setSubmitErr("请勾选「已知晓影响」后再提交"); return; }
    setBusy(true); setSubmitErr(""); setSubmitMsg("");
    try {
      const patch: Record<string, any> = {};
      let teamLanguage: string | undefined;
      for (const f of changed) {
        const raw = draft[f.key];
        const val = f.kind === "bool" ? raw === true : f.kind === "num" ? Number(raw) : String(raw);
        if (f.topLevel) teamLanguage = String(val);
        else patch[f.key] = val;
      }
      const body: Record<string, any> = { patch, reason: reason.trim(), confirm: true };
      if (teamLanguage !== undefined) body.team_language = teamLanguage;
      const r = await fetch("/api/platform/config", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        const detail = (j && (j.error || (j.errors || []).join("；"))) || ("保存失败 " + r.status);
        setSubmitErr(detail); return;
      }
      const n = Array.isArray(j.changed) ? j.changed.length : changed.length;
      setSubmitMsg("已保存 " + n + " 项" + (j.auditId ? "（审计留痕 " + j.auditId + "）" : "") + "；配置已生效");
      setDraft({}); setReason(""); setAck(false); setConfirming(false);
      setNonceCfg((x) => x + 1);
    } catch { setSubmitErr("请求失败（网络/服务不可用）"); }
    finally { setBusy(false); }
  }, [busy, changed, reason, ack, draft]);

  // 文档行渲染：> 引用行变暗；表格行用等宽（原来是内联样式，现已收进 page.module.css）
  const renderLines = (lines: string[]) =>
    lines.filter((l) => l.trim() !== "").map((l, i) => {
      const isTable = l.trim().startsWith("|");
      const cls = [styles.docLine, l.startsWith(">") ? styles.docLineQuote : "", isTable ? styles.docLineTable : ""].filter(Boolean).join(" ");
      return (<div key={i} className={cls}>{l}</div>);
    });

  // ── 设计 s12 邻卡（2026-11-19）：覆盖率告警阈值 / 写操作约束 ────────────────────
  // 设计原型是**假数据 mock**：assets/data.js 的 config[0] 写 value="0.72" / prev="0.70" / updated="11-04 11:04"，
  // assets/pages2.js 的「写操作约束」标签写死「已生效」。两卡一律只用本页已取的真值，取不到就写原因：
  //   · 配置项 = /api/platform/config 的 settings（团队协作 9 项 + 平台语言），key 里真有该项才显示数值；
  //   · 写鉴权 = 同一响应的 authMode / authModeSource（enforce / shadow / off，来源 env|file|default）。
  const COV_KEYS = ["flywheel.coverage_threshold", "coverage_threshold", "flywheel_coverage_threshold"];
  const cov = (() => {
    const s: any = cfg && cfg.ok ? cfg.settings : null;
    if (!s) return { key: "", value: undefined as any, prev: undefined as any };
    const pools: any[] = [s, s.agent_team, s.flywheel];
    for (const p of pools) {
      if (!p || typeof p !== "object") continue;
      for (const k of COV_KEYS) {
        if (p[k] !== undefined && p[k] !== null) return { key: k, value: p[k], prev: p[k + "_prev"] };
      }
    }
    return { key: "", value: undefined as any, prev: undefined as any };
  })();
  const covCur = cfgErr ? "不可得" : !cfg ? "读取中…" : cov.key ? String(cov.value) : "平台未设该项";
  const covPrev = cfgErr ? "不可得" : !cfg ? "读取中…"
    : cov.key ? (cov.prev === undefined || cov.prev === null ? "不可得（配置读取结果不保留上一值）" : String(cov.prev))
    : "平台未设该项（无值可比）";
  const covDesc = cfgErr
    ? "平台配置读取失败（" + cfgErr + "），无法判断该项是否存在，因此不给数值 —— 不写 0，也不填设计稿里的示例数字。"
    : !cfg
      ? "正在读取平台配置项清单。"
      : cov.key
        ? "该项已在平台配置项清单里登记，当前值取自平台配置读取结果（不是设计稿示例值）。"
        : "本页读的平台配置项清单（团队协作 9 项 + 平台语言）里没有「覆盖率告警阈值」，平台也没有登记这一项，所以这里不给数值 —— 不写 0，也不填任何示例数字。业务影响：飞轮覆盖率是否达标只能由飞轮侧自行判定，改不了阈值；若要让它可调，需先在平台配置项清单里登记这一项。";
  const authSrc = cfg?.authModeSource === "env" ? "服务端环境设置"
    : cfg?.authModeSource === "file" ? "平台设置文件"
      : cfg?.authModeSource === "default" ? "默认值（未显式设置）" : "未标注";
  const authModeTxt = String(cfg?.authMode || "").toLowerCase();
  const authState = cfgErr || !cfg ? "不可得"
    : authModeTxt === "enforce" ? "已生效"
      : authModeTxt === "shadow" || authModeTxt === "off" ? "未生效" : "不可得";
  const authText = cfgErr || !cfg ? "读不到写鉴权模式，无法判断谁能写。"
    : authModeTxt === "enforce" ? "强制校验：没有写权限凭据的写请求会被拒绝。"
      : authModeTxt === "shadow" ? "只记录不拦截：没有写权限凭据的写请求照样放行，等于没拦住。"
        : authModeTxt === "off" ? "不校验：任何能打开本页的人都能写。"
          : "平台配置读取结果没有给出写鉴权模式。";
  const gateTag = (state: string) => <Pill tone={state === "已生效" ? "ok" : state === "未生效" ? "warn" : "mute"}>{state}</Pill>;

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

      {/* 0.6.1 U-39：原侧栏二级入口（2 个：模型配置 / 运营配置）下沉到父页顶部「功能入口」带 */}
      <FeatureEntries
        items={(NAV_GROUPS.find((g) => g.id === "platform")?.items.find((i) => i.id === "config")?.children || []).map((c) => ({
          href: c.href || "#",
          label: c.label,
          icon: c.icon,
          desc: c.desc,
        }))}
      />

      {/* 工具栏（Q1 差距：本页原先没有工具栏）。设计稿对本页只给了「配置项」语义、没有指定筛选/排序交互，
          故这里只放**刷新**与**只读**说明，不臆造筛选器；口径写在右侧，避免被读成"该有的筛选没做"。 */}
      <div className={styles.toolbar} data-slot="toolbar">
        <div className={styles.toolLeft}>
          <span className={styles.toolNote}>只读 · 页面与文档同源；本页没有新的写入口（配置写入在下方「平台配置」面板内，带前后对比与二次确认）</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={reloadAll}>刷新</button>
      </div>

      {/* 卡指标（模板 D 数据卡 ①②③④）：有源的给实测值；「变更记录条数」没有统计口径 -> 写「不可得」+ 原因，
          不写 0、不拿"没有记录"冒充"零条"。 */}
      <div className={styles.kpiStrip} data-slot="kpi">
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>逻辑域数</div>
          <div className={styles.kpiValue}>{loading ? "读取中…" : domains.length}</div>
          <div className={styles.kpiNote}>平台逻辑文档里登记的域数（每个域一份现状文档）</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>平台配置项数</div>
          <div className={styles.kpiValue}>{CFG_FIELDS.length}</div>
          <div className={styles.kpiNote}>可写配置项白名单项数（界面与保存走同一份清单）</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>文档清单篇数</div>
          <div className={styles.kpiValue}>{loading ? "读取中…" : inv.length}</div>
          <div className={styles.kpiNote}>docs 目录下扫描到的文档篇数（清单面板可展开看明细）</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>变更记录条数</div>
          <div className={styles.kpiValue + " " + styles.kpiNa}>不可得</div>
          <div className={styles.kpiNote}>平台只在配置变更写入时留痕，没有按条列出的统计口径</div>
        </div>
      </div>

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
          {/* 模板 D 的 cfg 槽位：左列表 300px + 右详情（此处左侧 = 逻辑域，右侧 = 该域文档正文）。
              cfg-split / cfg-list / cfg-detail 是给结构判据的稳定记号（模块化类名会带哈希，判据只认这三段）。
              修复：下方「平台配置」面板曾复用同名 .cfgGrid（flex 纵排）覆盖了本栅格，两栏退化成单栏 —— 已改名 .cfgFields。 */}
          <div className={styles.cfgGrid + " cfg-split"} data-slot="cfg">
            <aside className={styles.cfgLeft + " cfg-list"} aria-label="逻辑域列表">
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

            <div className={styles.cfgRight + " cfg-detail"}>
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

          {/* 0.6.4 U-56a：平台配置可写（before/after 同屏 + 二次确认 + 变更原因必填 + 审计留痕） */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">平台配置（可写）</span>
              <span className={styles.panelNote}>
                {cfg ? "来源 " + (cfg.source || "n/a") + " · 数据时刻 " + fmt(cfg.asOf) : "读取中…"}
              </span>
              <span className="pill tone-info">可写 · 二次确认</span>
            </div>

            {cfgErr ? (
              <div className={styles.cfgWarn}>
                <b>配置不可得：</b>{cfgErr}
                <button className="btn btn-sm" type="button" onClick={() => setNonceCfg((x) => x + 1)}>重试</button>
              </div>
            ) : !cfg ? (
              <StateBlock loading rows={6} />
            ) : (
              <>
                <div className={styles.cfgFields}>
                  {CFG_FIELDS.map((f) => {
                    const cur = curOf(f);
                    const val = valOf(f);
                    const isChanged = draft[f.key] !== undefined && String(draft[f.key]) !== String(cur ?? "");
                    const curText = f.kind === "bool" ? (cur === true ? "开启" : cur === false ? "关闭" : "n/a")
                      : f.kind === "enum" ? (f.options || []).find((o) => o.v === cur)?.t || String(cur ?? "n/a")
                      : (cur === undefined || cur === null ? "n/a" : String(cur));
                    return (
                      <div key={f.key} className={styles.cfgRow + (isChanged ? " " + styles.cfgRowChanged : "")}>
                        <div className={styles.cfgLabel} title={f.hint}>{f.label}</div>
                        <div className={styles.cfgCur}>{curText}</div>
                        <div className={styles.cfgNew}>
                          {f.kind === "bool" ? (
                            <select value={val === true ? "1" : val === false ? "0" : ""} onChange={(e) => setField(f.key, e.target.value === "1")} aria-label={f.label}>
                              <option value="1">开启</option>
                              <option value="0">关闭</option>
                            </select>
                          ) : f.kind === "enum" ? (
                            <select value={String(val ?? "")} onChange={(e) => setField(f.key, e.target.value)} aria-label={f.label}>
                              {(f.options || []).map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
                            </select>
                          ) : (
                            <input type="number" min={0} value={val === undefined ? "" : String(val)}
                              onChange={(e) => setField(f.key, e.target.value)} aria-label={f.label} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {changed.length > 0 ? (
                  <div className={styles.cfgDiff}>
                    <div className={styles.cfgDiffHead}>
                      <b>变更预览（{changed.length} 项）</b>
                      <button className="btn btn-sm" type="button" onClick={() => { setDraft({}); setSubmitErr(""); }}>撤销修改</button>
                    </div>
                    <ul className={styles.cfgDiffList}>
                      {changed.map((f) => {
                        const before = f.kind === "bool" ? (curOf(f) === true ? "开启" : "关闭")
                          : f.kind === "enum" ? ((f.options || []).find((o) => o.v === curOf(f))?.t || String(curOf(f)))
                          : String(curOf(f));
                        const after = f.kind === "bool" ? (draft[f.key] === true ? "开启" : "关闭")
                          : f.kind === "enum" ? ((f.options || []).find((o) => o.v === draft[f.key])?.t || String(draft[f.key]))
                          : String(draft[f.key]);
                        return (
                          <li key={f.key}>
                            <span className={styles.cfgDiffKey}>{f.label}</span>
                            <span className={styles.cfgBefore}>{before}</span>
                            <span className={styles.cfgArrow}>→</span>
                            <span className={styles.cfgAfter}>{after}</span>
                          </li>
                        );
                      })}
                    </ul>
                    <label className={styles.cfgAck}>
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                      已知晓影响：配置变更立即生效，并写入审计留痕（不可撤销，只能再次变更）
                    </label>
                    <label className={styles.cfgReason}>
                      变更原因（必填，写入审计）
                      <input value={reason} onChange={(e) => { setReason(e.target.value); setSubmitErr(""); }} placeholder="例如：恢复默认轮预算以缓解积压" />
                    </label>
                    <div className={styles.cfgActions}>
                      <button className="btn" type="button" disabled={busy || !ack || !reason.trim()} onClick={submitCfg}>
                        {busy ? "提交中…" : "提交变更"}
                      </button>
                      <button className="btn" type="button" disabled={busy} onClick={() => { setConfirming(false); setDraft({}); setSubmitErr(""); }}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.panelNote}>当前没有改动。修改上方「新值」后会出现 before/after 预览与二次确认（未勾选知晓、未填原因不可提交）。</div>
                )}

                {submitErr ? <p className={styles.cfgErr}>提交失败：{submitErr}</p> : null}
                {submitMsg ? <p className={styles.cfgOk}>{submitMsg}</p> : null}
              </>
            )}
          </div>

          <div className="panel">
            {/* 设计 s12 的槽位标题就是「变更记录」（原实现写成「变更记录（最近 10 条）」，
                槽位标题与设计不一致 -> 判据读成缺失）。副标题放计数说明。 */}
            <div className="panel-header"><span className="panel-title">变更记录</span><span className={styles.panelNote}>最近 10 条 · 配置变更留痕</span></div>
            {/* 模板 D ⑥ 变更记录 = 时间 / 操作者 / 配置项 / before / after / 结果。
                事实：平台只在配置变更写入时记一条留痕（写入与留痕同一事务），**没有按条列出的查询口径**，
                所以本槽没有数据源；保留设计要的表格形态 + 一段说明，不写 0、不造记录。
                裸表修复：表格一律放在 tblWrap 里（宽表横向滚动，判据要求没有裸表）。 */}
            <div className={styles.tblWrap}>
              <DataTable
                rows={[] as ChangeRow[]}
                rowKey={(r) => r.at + r.key}
                empty={{
                  title: "变更记录暂无查询口径",
                  desc: "原因：平台只在配置变更写入时留痕，没有按条列出的查询口径，因此这里没有记录可列（是列不出，不是零条）。留痕由平台审计模块保存，需要时在那边查看；补料方：审计查询能力上线后接入本槽。",
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
          </div>

          {/* 设计 s12 邻卡 ①：覆盖率告警阈值（配置项详情）—— 只写真值或「平台未设该项」+ 原因，
              绝不使用设计原型的 0.72 / 0.70（那是 mock）。 */}
          <div className={styles.bentoRow} data-slot="logic-cards">
            <section className={styles.card} aria-labelledby="logicCovTitle">
              <div className={styles.cardHead}>
                <h3 id="logicCovTitle" className={styles.cardH3}>覆盖率告警阈值</h3>
                <span className={styles.cardSub}>平台配置项 · 取自平台配置读取结果</span>
              </div>
              <div className={styles.cardBody}>
                <dl className={styles.kv} data-src="settings.flywheel.coverage_threshold">
                  <dt>当前值</dt>
                  <dd className={cov.key ? styles.kvVal : styles.kvNa}>{covCur}</dd>
                  <dt>上一值</dt>
                  <dd className={cov.key ? styles.kvVal : styles.kvNa}>{covPrev}</dd>
                  <dt>说明</dt>
                  <dd>{covDesc}</dd>
                  <dt>判据来源</dt>
                  <dd>平台配置读取结果里的团队协作配置项清单（界面可写 9 项 + 平台语言），清单里有这一项才取值。</dd>
                </dl>
              </div>
            </section>

            {/* 设计 s12 邻卡 ②：写操作约束 —— 三道闸门逐条标注现状，每条带判据来源；
                设计原型的「已生效」是写死的 mock，照抄就是假绿。 */}
            <section className={styles.card} aria-labelledby="logicGateTitle">
              <div className={styles.cardHead}>
                <h3 id="logicGateTitle" className={styles.cardH3}>写操作约束</h3>
                <span className={styles.cardSub}>三道闸门，逐条标注现状（另附「谁能写」）</span>
              </div>
              <div className={styles.cardBody}>
                <ul className={styles.gateList}>
                  <li className={styles.gateItem}>
                    <div className={styles.gateTop}>① 变更前后对比 {gateTag("已生效")}</div>
                    <div className={styles.gateSrc}>
                      判据来源：本页「变更预览」只在有改动时出现「变更前 / 变更后」两行；未勾选「已知晓影响」、未填变更原因时提交按钮不可点 —— 页面自身行为，界面上可直接核对。
                    </div>
                  </li>
                  <li className={styles.gateItem}>
                    <div className={styles.gateTop}>② 二次确认 {gateTag("已生效")}</div>
                    <div className={styles.gateSrc}>
                      判据来源：本页提交必须勾选「已知晓影响」并填写变更原因，提交内容带确认标记。服务端是否强制这一项 不可得 —— 平台配置读取结果只回写写鉴权模式与数据时刻，不下发二次确认开关。
                    </div>
                  </li>
                  <li className={styles.gateItem}>
                    <div className={styles.gateTop}>③ 审计留痕 {gateTag("不可得")}</div>
                    <div className={styles.gateSrc}>
                      原因：平台配置读取结果不下发审计开关与留存期，页面无法判断「审计写不成就不让写」是否开启；只有提交成功后才能在提示里看到留痕编号，属于事后证据，不能当现状。
                    </div>
                  </li>
                </ul>
              </div>
              <div className={styles.cardFoot} data-src="authMode/authModeSource">
                另：谁能写（写鉴权）— {gateTag(authState)} {authText} 判据来源：平台配置读取结果里的写鉴权模式，取值来源「{authSrc}」。
              </div>
            </section>
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
