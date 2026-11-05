"use client";
// 概览首页 · 日结卡 (2026-09-15)
// 背景: 平台每天 00:00 自动生成飞轮日结 (主题 DAILY·YYYY-MM-DD, 正文在 summary 字段),
//       但此前界面上完全看不到 —— 首页没有入口, 反思页也不突出正文。
// 本卡片把最近一期日结直接搬到首页一屏: 整体概况 / 亮点 / 异常 / 今日关注,
// 并给出历史日结列表可就地切换日期, 不需要再去翻反思表。
//
// 2026-11-04（ord-20261104-032）：内联 style 清零 —— 24 处内联样式对象全部换成本页 CSS Module 的类，
//   声明值逐项不变；动态部分（选中态）走 data-active 属性选择器。取数与文案未动。
import { useEffect, useMemo, useState } from "react";
import { Button, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import { relTime } from "@/lib/format";
import styles from "../page.module.css";

const ISSUE_LABEL: Record<string, string> = {
  low_coverage: "覆盖不足",
  recurring: "复发未解决",
  task_failed: "任务失败",
  low_quality: "质量偏低",
};

function bjDateKey(offsetDays = 0): string {
  const ms = Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000;
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

function dayLabel(date: string): string {
  // 用日期的字面量做纯 UTC 计算, 不受浏览器本地时区影响 (否则非 UTC+8 浏览器会整体差一天)。
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${mo}月${d}日 周${"日一二三四五六"[dow]}`;
}

/** 日结正文是轻 markdown (标题 # / 加粗 **), 这里只做展示层清洗, 不改动接口原文。 */
function cleanText(s: string): string {
  return s
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 2026-10-13 round 76-DV: 加 loading —— 此前 data 已到但仍在加载时, 这一行会显示
 *  [完成 0] + [正常] 绿标(实测首页加载期出现 3 次), 是**假计数 + 假全好**。 */
function HistoryRow({
  h,
  active,
  onPick,
  loading,
}: {
  h: any;
  active: boolean;
  onPick: () => void;
  loading?: boolean;
}) {
  // 2026-10-13 round 76-EA: 76-DV 用页面级 loading 守卫过一次, 但**它不够** ——
  //   页面 loading 已为 false 时, 某些天的 counts 仍可能缺失 -> 又显示「完成 0」(实测复现)。
  //   改为**看这一行自己的数据**: counts 不在就显示 …(与页面 loading 取或)。
  const hasCounts = !!(h && h.counts);
  const failed = Number(h?.counts?.tasksFailed || 0);
  const done = Number(h?.counts?.tasksDone || 0);
  return (
    <button
      type="button"
      onClick={onPick}
      className={styles.histRow}
      data-active={active ? "true" : "false"}
    >
      <span className={styles.histDay}>
        {dayLabel(h.date)}
        {h.date === bjDateKey(-1) ? <span className="tiny"> · 昨天</span> : null}
      </span>
      <span className="tiny nowrap">
        完成 {loading || !hasCounts ? "…" : done}
        {!loading && hasCounts && failed > 0 ? ` · 失败 ${failed}` : ""}
      </span>
      {loading || !hasCounts ? <Pill tone="mute">…</Pill> : <Pill tone={failed > 0 ? "crit" : "ok"}>{failed > 0 ? "有失败" : "正常"}</Pill>}
    </button>
  );
}

export default function OverviewDailyCard({ data, loading }: { data: any; loading: boolean }) {
  const history: any[] = useMemo(() => (Array.isArray(data?.history) ? data.history : []), [data]);
  // 2026-10-13 round 76-DV: 详情区的数字原来一律 `?? 0` —— 字段还没到时会显示一串 0(假计数)。
  //   本页没有独立的详情请求(item 由 history 派生), 所以用页面的 loading 做守卫。
  const v = (n: any) => (loading ? "…" : (n ?? 0));
  const [selected, setSelected] = useState<string>("");
  const [expanded, setExpanded] = useState(false);

  // 初次拿到数据 / 刷新后: 默认看最近一期 (不覆盖用户已选中的历史). 用 id 选中, 同名日期也不会串行。
  useEffect(() => {
    if (!selected && data?.latest?.id) setSelected(data.latest.id);
  }, [data, selected]);

  const item = useMemo(() => {
    if (!history.length) return data?.latest || null;
    return history.find((h) => h.id === selected) || history[0];
  }, [history, selected, data]);

  const summary: string = cleanText(item?.summary || "");
  const collapsed = summary.length > 260;
  const shownSummary = expanded || !collapsed ? summary : summary.slice(0, 260) + "…";

  const isYesterday = item?.date === bjDateKey(-1);

  return (
    <div className={"card-grid " + styles.dcWrap}>
      <PanelCard
        title="日结"
        tone="var(--primary)"
        extra={
          <span className={styles.dcExtra}>
            {item ? (
              <span className="tiny">
                {isYesterday ? "昨天" : dayLabel(item.date)} · 生成 {item.generatedAt ? relTime(item.generatedAt) : "-"}
              </span>
            ) : null}
            <a href="/flywheel/reflections" className="tiny">
              全部反思 →
            </a>
          </span>
        }
      >
        {loading && !data ? (
          <StateBlock loading title="正在读取日结" rows={3} />
        ) : !item ? (
          <StateBlock
            title="暂无日结"
            desc={
              data?.warnings?.length
                ? data.warnings.join("；")
                : "飞轮每天 00:00 自动生成日结; 生成后这里会显示昨天发生了什么、哪里不对、今天关注什么。"
            }
            rows={2}
          />
        ) : (
          <div className={styles.dcBody}>
            {/* ---------- 主区: 昨日日结正文与要点 ---------- */}
            <div className={styles.dcCol}>
              <div className={styles.dcHead}>
                <Pill tone="info">{dayLabel(item.date)}</Pill>
                <span className="tiny">
                  主题 {v(item.overview?.themesReflected)} · 活跃会话 {v(item.overview?.activeSessions)} · 消息{" "}
                  {v(item.overview?.messages)}
                </span>
                <span className="tiny">
                  新增产物{" "}
                  {loading ? "…" : (item.products?.memory ?? 0) + (item.products?.knowledge ?? 0) + (item.products?.practice ?? 0)} 条 ·
                  任务完成 {v(item.counts?.tasksDone)}
                  {Number(item.counts?.tasksFailed || 0) > 0 ? (
                    <span className={styles.dcCrit}> · 失败 {item.counts.tasksFailed}</span>
                  ) : (
                    " · 失败 0"
                  )}{" "}
                  · 执行 {item.counts?.executions ?? 0} 次
                </span>
              </div>

              <div className={styles.dcSection}>
                <div className={styles.dcH}>整体概况</div>
                <div className={styles.dcText}>
                  {shownSummary || "该日日结未包含正文。"}
                </div>
                {collapsed ? (
                  <Button size="small" type="link" className={styles.dcExpand} onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "收起" : "展开全文"}
                  </Button>
                ) : null}
              </div>

              <div className={styles.dcTwo}>
                <div>
                  <div className={styles.dcH + " " + styles.dcHOk}>亮点</div>
                  {(item.highlights || []).length === 0 ? (
                    <span className="tiny">昨日无特别亮点</span>
                  ) : (
                    (item.highlights || []).map((h: string, i: number) => (
                      <div key={i} className={styles.dcItem}>
                        • {h}
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div className={styles.dcH + " " + styles.dcHCrit}>异常</div>
                  {(item.issues || []).length === 0 ? (
                    <span className="tiny">昨日未发现明显异常</span>
                  ) : (
                    (item.issues || []).map((x: any, i: number) => (
                      <div key={i} className={styles.dcItem}>
                        • <span className={styles.dcDim}>[{ISSUE_LABEL[x.type] || x.type}]</span> {x.detail}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className={styles.dcFocus}>
                <div className={styles.dcH}>今日关注</div>
                {(item.focus || []).length === 0 ? (
                  <span className="tiny">昨日数据未给出明确关注项</span>
                ) : (
                  <div className={styles.dcFocusList}>
                    {(item.focus || []).map((f: any, i: number) => (
                      <Tooltip key={i} title={f.reason}>
                        <span className="pill warn">
                          {f.theme}
                          {f.coverage != null ? ` · 覆盖度 ${Number(f.coverage).toFixed(2)}` : ""}
                        </span>
                      </Tooltip>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ---------- 侧栏: 历史日结列表 (点即切换) ---------- */}
            <div className={styles.dcSide}>
              <div className={styles.dcSideH}>历史日结</div>
              <div className={styles.dcHistory}>
                {history.map((h) => (
                  <HistoryRow key={h.id || h.date} h={h} active={h.id === item.id} onPick={() => setSelected(h.id)} loading={loading} />
                ))}
              </div>
            </div>
          </div>
        )}
      </PanelCard>
    </div>
  );
}