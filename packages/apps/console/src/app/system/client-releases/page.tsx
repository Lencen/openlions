"use client";
// 2026-10-29 客户端版本管理（console）。
// 契约：docs/productization/CLIENT-RELEASE-SERVICE-2026-10-29.md
// 口径：服务未接入 → 明确写"未接入"，不写"暂无数据"；未签名包也要可见（否则被误读成"没这个版本"）。
// ---------------------------------------------------------------------------
// 2026-11-04 · P1 试点页呈现层改造（ord-20261104-032）· 模板 A 列表
// 取数 0 改动：仍是 useApi('/api/client-releases', { pollMs: 30000 })，端点/参数不变。
// 四态落点：
//   · 加载：发布记录 DataTable loading（骨架行 = 真实列数）
//   · 错误：DataTable error + 重试（mutate；不改取数参数）
//   · 空  ：available=false → 「发布服务未接入」；服务已接入但 0 条 → 「还没有任何发布记录」；
//           有数据但筛选/搜索 0 条 → 「没有匹配」（给清除搜索），三种空态互不冒充
//   · 无权限：error 文案 401/403 或含「无权限/未授权」-> 整页 StateBlock「无权限访问」
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { Input } from "@/components/primitives";
import { KpiCard, DataTable, StateChip, StateBlock, FilterBar, PageHeader, PageTitle, Pill } from "@/components/ui";
import styles from "./page.module.css";

interface Release {
  id?: string;
  version?: string;
  platform?: string;
  arch?: string;
  filename?: string;
  sizeBytes?: number;
  sha256?: string;
  // 2026-10-30 修正：服务返回的是 signed(boolean) 与 key_id，不是 signature/signed_by。
  // 之前页面读 signature -> 恒为空 -> 每行都显示"未签名"（而发布时其实自动签了）。
  signed?: boolean;
  key_id?: string | null;
  state?: string;
  channel?: string;
  notes?: string;
  publishedAt?: string | null;
}
interface Resp {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  items?: Release[];
  latest?: Release | null;
  asOf?: string;
}

const STATE_LABEL: Record<string, string> = {
  draft: "草稿",
  pending_sign: "待签名",
  signed: "已签名待发布",
  published: "已发布",
  deprecated: "已弃用",
  revoked: "已撤销",
};

// 2026-10-30：安装包只有几 KB 时，MB 保留一位会显示 "0.0 MB"——等于没显示。
const fmtSize = (n?: number) => {
  if (typeof n !== "number") return "未知";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const short = (s?: string | null) => (s ? String(s).slice(0, 16) : "—");
const when = (s?: string | null) => (s ? String(s).slice(0, 19).replace("T", " ") : "—");

/** 无权限的唯一判定口：401/403 或文案含「无权限 / 未授权」。只决定渲染哪个四态，不吞错误。 */
const FORBIDDEN_RE = /401|403|无权限|未授权|unauthori[sz]ed|forbidden/i;

type ViewKey = "all" | "published" | "unsigned" | "revoked";

/** 实例表的一行（PILOT-10 §10：主机 / 系统 / agent / 版本 / 心跳 / 状态）。
 *  当前 BFF 不下发实例 —— 表结构与列先就位，rows 恒为空由 empty 说明触发条件，不编造实例。 */
interface InstRow { host: string; os: string; agent: string; version: string; heartbeat: string; state: string }

export default function ClientReleasesPage() {
  const { data, loading, error, mutate } = useApi<Resp>("/api/client-releases", { pollMs: 30000 });
  const items = data?.items ?? [];

  // 搜索（模板 A §搜索）：范围 = 版本 / 通道 / 文件名，250ms 防抖；清空即恢复全部。
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQApplied(q.trim().toLowerCase()), 250);
    return () => clearTimeout(id);
  }, [q]);

  // 视图分段（模板 A 工具条）：筛选是读操作 —— 本页无写控件。
  const [view, setView] = useState<ViewKey>("all");

  const counts = {
    all: items.length,
    published: items.filter((r) => r.state === "published").length,
    unsigned: items.filter((r) => r.signed === false).length,
    revoked: items.filter((r) => r.state === "revoked").length,
  };
  const matched = items.filter((r) => {
    if (view === "published" && r.state !== "published") return false;
    if (view === "unsigned" && r.signed !== false) return false;
    if (view === "revoked" && r.state !== "revoked") return false;
    if (!qApplied) return true;
    return [r.version, r.channel, r.filename].some((v) => String(v ?? "").toLowerCase().includes(qApplied));
  });
  // 默认排序 = 发布时间倒序（模板 A §排序默认「需要关注」在前；同值按 id 兜底保持稳定）。
  const rows = [...matched].sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return String(a.id ?? a.version ?? "").localeCompare(String(b.id ?? b.version ?? ""));
  });

  // 「最新版本」优先取 BFF 的 latest；latest 缺失时退到「发布时间最新的一行」（派生展示，不改字段口径）
  const latest = data?.latest ?? rows[0] ?? null;
  const hasFilter = !!qApplied || view !== "all";
  const errText = error ? String((error as Error)?.message || error) : "";
  const forbidden = FORBIDDEN_RE.test(errText);
  const serviceDown = !loading && !error && data?.available === false;
  const noMatch = !loading && !error && items.length > 0 && rows.length === 0 && (!!qApplied || view !== "all");

  const filters = [
    { key: "all", label: "全部", count: counts.all },
    { key: "published", label: "已发布", count: counts.published },
    { key: "unsigned", label: "未签名", count: counts.unsigned },
    { key: "revoked", label: "已撤销", count: counts.revoked },
  ];

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb"><span className={styles.bcDim}>平台管理</span><span className="sep">/</span><span className="current">客户端版本</span></div>
      <PageHeader>
        <PageTitle>客户端版本</PageTitle>
        <div className="page-subtitle">
          发布即签名；portal 只展示最新版。数据时刻 {when(data?.asOf)}
        </div>
        <div className={styles.headerTags}>
          <Pill tone="mute">只读</Pill>
          <Pill tone="info">列表 · 5min 聚合</Pill>
        </div>
      </PageHeader>

      {forbidden ? (
        // 四态 · 无权限：整页替换（缺哪个权限点 + 找谁开通 + 申请授权）
        <StateBlock
          title="无权限访问"
          desc={<>
            缺少客户端发布记录的只读权限点 <code>system.clientReleases</code>（键名与 nav 的 <code>clientReleases</code> 对齐）。<br />
            找平台管理员 / devops 值班开通；也可在「权限管理」页发起授权申请。
          </>}
          action={<a className="btn btn-sm" href="/system/permissions">申请授权</a>}
        />
      ) : (<>
        <div className="kpi-grid">
          <KpiCard label="最新版本" value={latest?.version || "—"} hint={"portal 只展示最新版" + (latest?.channel ? " · 通道 " + latest.channel : "")} />
          <KpiCard label="发布记录" value={items.length} hint={"未签名 " + counts.unsigned + " · 已撤销 " + counts.revoked} />
          {/* 下面两张是数据卡点名的指标，但字典未给口径 / 服务未下发字段（数据卡「数据缺口」）——
              按字典「缺失一律 n/a + 原因」显示 n/a，不写 0（写 0 会被读成"真的没覆盖"）。 */}
          <KpiCard label="车队规模" value="暂无" hint="客户端实例清单尚未接入" />
          <KpiCard label="版本覆盖" value="暂无" hint="版本覆盖口径待补齐" />
        </div>

        {/* 工具条（模板 A）：搜索在最左 + 视图分段 + 右侧只读说明/计数 */}
        <div className={styles.toolRow}>
          <Input
            className={styles.searchInput}
            value={q}
            onChange={(e: any) => setQ(e.target.value)}
            onPressEnter={() => setQApplied(q.trim().toLowerCase())}
            placeholder="搜索 版本 / 通道 / 文件名"
          />
          <span className={styles.toolNote}>只读；发布记录含未签名与已撤销，「未签名」不等于「没有这个版本」。</span>
        </div>
        <div className={styles.filterBarWrap}>
          <FilterBar items={filters} active={view} onSelect={(k) => setView(k as ViewKey)} right={loading && items.length === 0 ? <>加载中…</> : <>共 {rows.length} 条{hasFilter ? "（筛选后）" : ""}</>} />
        </div>

        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">全部版本（含未签名与已撤销）</span>
            <span className={styles.panelNote}>默认按发布时间倒序</span>
          </div>
          {error ? (
            // 错误态说明保留原页的诚实口径：取不到 ≠ 没有版本（DataTable 的 error 槽是固定文案，细节放这里）
            <div className={styles.toolNote}>读数暂时取不到，这不代表没有版本；接口恢复后点表内「重试」即可，不要据此判断「没有发布过」。</div>
          ) : null}
          <DataTable
            rows={rows}
            rowKey={(r, i) => r.id || r.version || i}
            loading={loading && items.length === 0}
            error={error ? "读数暂时取不到（这不代表没有版本）" : null}
            onRetry={() => { mutate(); }}
            empty={
              noMatch
                ? { title: "没有匹配的版本", desc: "触发条件：搜索或筛选后 0 条。已发布过的版本不会因此消失。", action: <button className="btn" onClick={() => { setQ(""); setQApplied(""); setView("all"); }}>清除搜索与筛选</button> }
                : serviceDown
                  ? { title: "发布服务未接入", desc: data?.reason || "客户端版本管理服务尚未上线；此处不写「暂无数据」，因为那会被读成「没有发布过任何版本」。" }
                  : { title: "还没有任何发布记录", desc: "触发条件：服务已接入，但没有任何版本登记（draft 也会出现在这张表里）。首次发布指引见仓库 docs/productization/CLIENT-RELEASE-SERVICE-2026-10-29.md。" }
            }
            columns={[
              { key: "version", title: "版本", width: "140px", render: (r) => <span className="mono">{r.version || "—"}</span> },
              { key: "format", title: "平台 / 架构（包格式）", render: (r) => [r.platform, r.arch].filter(Boolean).join(" / ") || "—" },
              { key: "size", title: "大小", align: "right", width: "110px", render: (r) => fmtSize(r.sizeBytes) },
              {
                key: "signed", title: "签名", width: "150px",
                render: (r) => (<>
                  {/* 2026-10-30：未知 ≠ 否。字段缺失时不能说"未签名"（那是确定的反面结论），只能显示"未知"。 */}
                  {r.signed === true
                    ? <StateChip state="ok" text="已签名" />
                    : r.signed === false
                      ? <StateChip state="crit" text="未签名" />
                      : <StateChip state="idle" text="签名状态未知" />}
                  {r.key_id ? <div className={styles.keyId + " tiny"}>key_id {String(r.key_id).slice(0, 16)}</div> : null}
                </>),
              },
              {
                key: "state", title: "状态", width: "130px",
                render: (r) => {
                  const s = String(r.state ?? "");
                  const tone = s === "published" ? "ok" : s === "revoked" ? "crit" : s === "deprecated" ? "warn" : "idle";
                  return <StateChip state={tone as "ok" | "warn" | "crit" | "idle"} text={STATE_LABEL[s] || r.state || "—"} />;
                },
              },
              { key: "channel", title: "通道", width: "110px", render: (r) => r.channel || "—" },
              { key: "sha256", title: "校验和", width: "170px", render: (r) => <span className="mono tiny" title={r.sha256 || ""}>{short(r.sha256)}</span> },
              { key: "publishedAt", title: "发布", align: "right", width: "170px", render: (r) => <span className="mono tiny">{when(r.publishedAt)}</span> },
            ]}
          />
          <div className={styles.tableFoot}>
            未签名的包也会出现在这里——「未签名」与「没有这个版本」是两件事。表头排序（发布时间 / 下载数）将在表格支持排序后接入；下载数当前无数据。
          </div>
        </div>

        {/* PILOT-10 §10「实例：无表 -> DataTable（主机 / 系统 / 智能体 / 版本 / 心跳 / 状态）」。
            本页没有实例数据源（本批不改取数），先占位并写清缺什么，不编造实例。 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">实例（车队）</span><span className={styles.panelNote}>数据卡 10 · 待补</span></div>
          <DataTable
            rows={[] as InstRow[]}
            rowKey={(r) => r.host}
            empty={{
              title: "实例清单未接入",
              desc: "触发条件：服务端尚未提供客户端实例（主机 / 系统 / 智能体 / 版本 / 心跳 / 状态）。",
            }}
            columns={[
              { key: "host", title: "主机" },
              { key: "os", title: "系统" },
              { key: "agent", title: "智能体" },
              { key: "version", title: "版本" },
              { key: "heartbeat", title: "心跳", align: "right" },
              { key: "state", title: "状态" },
            ]}
          />
        </div>

        {/* 模板 A 页脚：默认排序 + 数据时刻 + 异常判据（数据卡 A/B/C，可复跑） */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">口径与异常判据</span><span className={styles.panelNote}>数据时刻 {when(data?.asOf)}</span></div>
          <div className={styles.footNote}>
            聚合 5 分钟（Asia/Shanghai）；本页只读，可写仅限平台配置页。<br />
            异常判据（可复跑）：<code>node scripts/check-client-process-version.cjs</code> 末行 <code>FAIL 陈旧进程 k/N</code>（k≥1）即异常 ·
            <code>node scripts/check-client-release-chain.cjs</code> 任一环 <code>FAIL</code> 即异常 ·
            <code>systemctl --user list-units --state=failed --no-legend --plain</code> 出现 <code>lions-*</code> failed 行即异常。
          </div>
        </div>
      </>)}
    </main></div>
  );
}
