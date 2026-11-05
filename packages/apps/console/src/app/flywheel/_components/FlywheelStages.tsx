"use client";
/**
 * FlywheelStages.tsx — 飞轮六段步骤条（P1 试点 · 看板模板 C 的「Bento 域格」= 六段）
 *
 * 2026-11-04（ord-20261104-032）：PILOT-10 §7 的「改后」要求把六段从「文字描述」改成
 *   「六段步骤条（段名 / 数值 / 说明）」，并给每段一条覆盖率条。这里按模板落地：
 *   每格一个段，数值 = 该段最近 5 分钟经过的事件条数（与 /flywheel/flow 的图同一口径），
 *   说明 = 该段的定义；整格可点 → /flywheel/flow。
 *
 * 取数：只读 /api/flywheel-flow（既有端点，未改参数）。六段顺序/文案回落到 shared.ts 的 STAGES，
 *   接口失败时显式标「该段不可用」，不整页报错（单域降级）。
 *
 * TODO(数据卡 · 飞轮)：PILOT-10 要求「每段一条覆盖率，低于阈值转黄」，但数据卡尚未定义
 *   段级覆盖率口径（现有 coverage 是「主题覆盖率」，不是「段覆盖率」）—— 这里只画出占位条并标
 *   「覆盖率 —」，不编造百分比；口径到位后把 cov 从 undefined 换成真实比率即可自动转黄。
 */
import Link from "next/link";
import { useApi } from "@/lib/api";
import { STAGES, fmt } from "./shared";
import styles from "../page.module.css";

type Step = {
  id: string;
  label: string;
  desc?: string | null;
  qty?: { m5?: number; h1?: number; h24?: number } | null;
};

/** 图/条上的段名用简称（业务含义不变，只是短） */
const SHORT: Record<string, string> = {
  scan: "扫描",
  extract: "提取",
  write: "写入",
  generateTasks: "生成任务",
  improve: "改进任务",
  reflect: "反思",
  structure: "结构化",
  backfill: "回填",
};

const WIDTH_CLASS: Record<number, string> = { 0: "w0", 10: "w10", 20: "w20", 30: "w30", 40: "w40", 50: "w50", 60: "w60", 70: "w70", 80: "w80", 90: "w90", 100: "w100" };

export default function FlywheelStages() {
  const { data, loading, error } = useApi<any>("/api/flywheel-flow", { pollMs: 60000 });
  const steps: Step[] = Array.isArray(data?.steps) ? (data.steps as Step[]) : [];
  const cells: Step[] = (steps.length
    ? steps
    : STAGES.map((s) => ({ id: s.id, label: s.label, desc: s.desc, qty: {} }))
  ).slice(0, 6);
  const errText = error ? String((error as Error)?.message || error).slice(0, 80) : "";

  return (
    <section className={styles.bento} aria-label="飞轮六段">
      {cells.map((c) => {
        const m5 = Number(c.qty?.m5) || 0;
        const h1 = Number(c.qty?.h1) || 0;
        const h24 = Number(c.qty?.h24) || 0;
        // TODO(数据卡 · 飞轮)：段级覆盖率口径未提供 —— 恒为 undefined，不编造数字。
        const cov: number | undefined = undefined;
        const tone = cov === undefined ? "idle" : cov < 0.6 ? "warn" : "ok";
        const widthCls = WIDTH_CLASS[cov === undefined ? 0 : Math.round((cov * 100) / 10) * 10] || "w0";
        return (
          <Link key={c.id} className={styles.cell + " " + styles.s4} href="/flywheel/flow">
            <div className={styles.cellHead}>
              <span className={styles.cellName}>{SHORT[c.id] || c.label}</span>
              <span className={styles.cellKicker}>近 5 分钟</span>
              <span className={styles.cellGo}>流水线 →</span>
            </div>
            {error ? (
              <div className={styles.cellHint}>该段不可用（/api/flywheel-flow：{errText}）</div>
            ) : loading && !data ? (
              <span className={styles.skel} />
            ) : (
              <>
                <div className={styles.cellValue}>{fmt(m5)}</div>
                <div className={styles.cellHint}>
                  {c.desc || "—"}
                  <br />
                  近 1 小时 {fmt(h1)} · 近 24 小时 {fmt(h24)}
                </div>
                <div className={styles.meterRow}>
                  <span>覆盖率</span>
                  <span className={styles.meter}>
                    <span className={styles.meterFill + " " + styles[widthCls]} data-tone={tone} />
                  </span>
                  <span>{cov === undefined ? "—（待数据卡）" : Math.round(cov * 100) + "%"}</span>
                </div>
              </>
            )}
          </Link>
        );
      })}
    </section>
  );
}
