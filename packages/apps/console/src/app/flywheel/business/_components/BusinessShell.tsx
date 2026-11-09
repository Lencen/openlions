"use client";
// 2026-11-05 P2 批6（B/飞轮业务）：内联 style 清零（13 → 0）。
//   维度 tab 的选中态 -> [data-on]；快照状态条（degraded/stale/ok）的左描边与状态词颜色 -> [data-tone]；
//   其余静态布局/字号下沉到 BusinessShell.module.css，文字层级复用 globals 的 .tiny。
//   取数、路由、URL 参数、文案与 props 形状均未动。
import Link from "next/link";
import type { ReactNode } from "react";
import type { ApiResponse } from "./types";
import { DIMENSIONS, cp, ci, ctime } from "./caliber";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./BusinessShell.module.css";

const TABS = [
  // 2026-11-05 商业线裁决 C：/flywheel/business 已 301 -> /market，所以"总览"这个 Tab 直接指向 /market
  //   （否则 check-offline-301 第 4 条会把它算成"保留目录里还有指向旧路由的链接"）。
  //   目录保留 60 天指的是**代码不删**，不是内容冻结；维度页仍走 d.href（那两条也已被 301 覆盖）。
  { id: "overview", href: "/market", label: "总览" },
  ...DIMENSIONS.map((d) => ({ id: d.id, href: d.href, label: d.code + " " + d.title })),
];

export default function BusinessShell({
  data, active, title, subtitle, onRefresh, refreshing, children,
}: {
  data: ApiResponse;
  active: string;
  title: string;
  subtitle: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
  children: ReactNode;
}) {
  const s = data.data;
  const b = (s && s.business) || {};
  const health = b.health || {};
  const regime = b.regime || {};
  const win = (s && s.window) || {};
  const fileName = data.path ? data.path.split("/").pop() : "—";
  // 2026-11-05 P2 批6：状态词与描边色不再算成 CSS 变量字符串，改由 data-tone 交给 CSS 选择器
  const tone = data.degraded ? "crit" : data.stale ? "warn" : "ok";
  const toneLabel = data.degraded ? "业务扩展缺失" : data.stale ? "快照偏旧" : "快照正常";

  return (
    <div className="layout-with-sidebar">
      <main className="main" data-testid="flywheel-business">
        <PageHeader>
          <div className={styles.headRow}>
            <div>
              <PageTitle>飞轮业务看板 · {title}</PageTitle>
              <div className="page-subtitle">{subtitle}</div>
            </div>
            <div className={"tiny " + styles.meta}>
              <div>数据截至 {ctime(data.asOf)}（Asia/Shanghai）</div>
              <div>窗口 {win.label || "—"} · {win.timezone || "UTC"}</div>
              <div>阶段 {regime.current || "—"} · {regime.label || "未标注"} · 跨阶段可比：{regime.comparable === false ? "否" : "是"}</div>
              <div>数据健康 {health.score == null ? "不可测" : ci(health.score) + "/100"} · 健康红线 {ci((health.redlines || []).length)} 项</div>
              <DataMoment items={[{ label: "快照", at: data.asOf }]} />
            </div>
          </div>
        </PageHeader>

        <nav aria-label="业务维度" className={styles.tabs}>
          {TABS.map((t) => {
            const on = active === t.id;
            return (
              <Link key={t.id} href={t.href} data-tab={t.id} data-on={on} className={styles.tab}>
                {t.label}
              </Link>
            );
          })}
        </nav>

        <div className={"panel " + styles.banner} data-tone={tone}>
          <div className={"tiny " + styles.bannerText}>
            <strong className={styles.tone}>{toneLabel}</strong>
            {data.ageMinutes != null ? <span className={styles.mutedText}> · 生成于 {data.ageMinutes} 分钟前</span> : null}
            {data.notice ? <span className={styles.dimText}> · {data.notice}</span> : null}
            {!data.notice ? <span className={styles.mutedText}> · 文件 {fileName} · 来源 {data.source === "business" ? "业务扩展快照" : "权威快照"}</span> : null}
          </div>
          <button className="ui-btn ui-btn-small ui-btn-default" onClick={onRefresh} disabled={refreshing} type="button">
            {refreshing ? "生成中…" : "重新生成快照"}
          </button>
        </div>

        {children}

        <section className={"panel " + styles.about}>
          <div className="panel-title">口径、血缘与无数据规则</div>
          <div className={"tiny " + styles.aboutText}>
            <div>唯一数据入口：<code>run/flywheel-business-snapshot-latest.json</code>（权威契约 v1 + 业务扩展）；页面不直接读业务表。</div>
            <div>权威快照由 <code>node scripts/flywheel-report.cjs --hours=24 --write</code> 产出；业务扩展由 <code>node scripts/flywheel-business-report.cjs --hours=24 --write</code> 产出。</div>
            <div>无数据 ≠ 达标：所有不可测项用灰色“无数据”标注，并在 D3 的“无数据 / 不完整项”给出原因与复算命令，不画成 0。</div>
            <div>时间：业务表 UTC；审计记录 Asia/Shanghai 本地墙钟；页面统一按 Asia/Shanghai 展示并标注。</div>
            <div>词元：网关通道级为总量；平台内部单列；逐智能体归因只做参考；三者不相加；单价未配，不出精确金额。</div>
            <div>阶段：R1 ≤ 2026-10-08 / R2 2026-10-09–10-21 / R3 ≥ 2026-10-22；跨阶段不直接比较。</div>
            {b.canonicalWarnings && b.canonicalWarnings.length ? <div>权威口径警示：{b.canonicalWarnings.map((w: any) => w.field).join(" / ")}（详见 D3）。</div> : null}
            {data.degraded ? <div className={styles.critLine}>当前业务扩展缺失：先运行生成命令，再刷新本页。</div> : null}
          </div>
        </section>
      </main>
    </div>
  );
}
