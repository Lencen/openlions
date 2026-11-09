"use client";
// 数据卡 9（/flywheel）落地条：4 条判据的实时值 + 阈值 + 状态（2026-11-06）
// 口径：data-cards/card-9-flywheel.md；取不到 -> 「取不到 + 原因」，不写 0。
import { useApi } from "@/lib/api";
import { Pill, StateBlock } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import styles from "./Card9Checks.module.css";

type Check = { id: string; label: string; threshold: string; value: string | null; valueNum?: number | null; state: "pass" | "fail" | "na"; reason?: string };
// 2026-11-06：status 三档 —— ok / partial（有条目 na）/ unknown（连不上库）
type Resp = { status: "ok" | "partial" | "unknown"; reason?: string; asOf?: string; checks?: Check[] };

const TONE: Record<string, { text: string; tone: "ok" | "warn" | "neutral" }> = {
  pass: { text: "正常", tone: "ok" },
  fail: { text: "异常", tone: "warn" },
  na: { text: "不可判", tone: "neutral" },
};

export default function Card9Checks() {
  const { data, loading } = useApi<Resp>("/api/flywheel/card9", { pollMs: 60000 });
  const d = data || { status: "ok" as const };
  const checks = d.checks || [];

  return (
    <section className={styles.wrap}>
      <header className={styles.head}>
        <h2 className={styles.h2}>卡 9 判据（阈值即口径）</h2>
        <DataMoment items={[{ label: "判据", at: d.asOf }]} />
      </header>
      {d.status === "unknown" ? (
        <StateBlock title="取不到判据值" desc={d.reason || "接口返回 unknown"} />
      ) : loading && checks.length === 0 ? (
        <StateBlock title="加载中" rows={2} />
      ) : (
        <ul className={styles.list}>
          {checks.map((c) => {
            const t = TONE[c.state] || TONE.na;
            return (
              <li key={c.id} className={styles.row}>
                <span className={styles.label}>{c.label}</span>
                <span className={styles.thr}>{c.threshold}</span>
                <span className={styles.val}>{c.value ?? "不可得"}{c.value == null && c.reason ? "（" + c.reason + "）" : ""}</span>
                <Pill tone={t.tone as any}>{t.text}</Pill>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
