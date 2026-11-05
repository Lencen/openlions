"use client";
// 概览首页 · 质量分概览 + 未提炼积压 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
//
// 2026-11-04（ord-20261104-032）：内联 style 清零 —— 12 处内联样式对象换成 page.module.css 的类，
//   声明值逐项不变；动态色（表 ink / 质量档）走查表后的类名。取数与文案未动。
import { Progress } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard, StateBlock } from "@/components/ui";
import { fmtNum, fmtScore, qualityTone } from "@/lib/format";
import { t } from "@/i18n";
import { TABLE_LABEL } from "./constants";
import styles from "../page.module.css";

const INK: Record<string, string> = {
  Memory: styles.inkMemory,
  Knowledge: styles.inkKnowledge,
  Practice: styles.inkPractice,
  Skill: styles.inkSkill,
};
const TONE: Record<string, string> = {
  ok: styles.toneOk,
  warn: styles.toneWarn,
  crit: styles.toneCrit,
  mute: styles.toneMute,
};

export default function OverviewQualityPanels({ data, loadingCards }: { data: any; loadingCards: boolean }) {
  const quality = data?.quality;
  const backlog = data?.backlog;

  return (
    <div className="card-grid main-side">
      <PanelCard title="质量分概览" extra={<span className="tiny">{t('biz.quality.caliber')}</span>}>
        {loadingCards ? <StateBlock loading rows={3} /> : (
          <div className={styles.qpCol}>
            {(["Memory", "Knowledge", "Practice", "Skill"] as const).map((t) => {
              const q = quality?.byTable?.[t] || { n: 0, scored: 0, unscored: 0, avg: 0, high: 0, low: 0 };
              const tone = qualityTone(q.avg);
              return (
                <div key={t}>
                  <div className={styles.qpRow}>
                    <span className={styles.qpName + " " + (INK[t] || "")}>{TABLE_LABEL[t]}</span>
                    <span className="tiny">{fmtNum(q.n)} 条 (窗口内) · 已评分 {fmtNum(q.scored)} · 未评分 {fmtNum(q.unscored)}</span>
                    <span className={styles.qpScore + " " + (TONE[tone.cls] || "")}>{fmtScore(q.avg)}</span>
                  </div>
                  <Progress
                    percent={Math.round(Number(q.avg || 0) * 100)}
                    showInfo={false}
                    strokeColor={tone.color}
                    railColor="var(--bg-surface2)"
                    size={{ height: 8 }}
                  />
                  <div className={"tiny " + styles.qpFoot}>
                    高质量(≥0.7) {fmtNum(q.high)} · 偏低(&lt;0.4) {fmtNum(q.low)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      <PanelCard title="未提炼会话积压" tone="var(--status-warn)" extra={<span className="tiny">全量口径 (不受时间窗限制)</span>}>
        {loadingCards ? <StateBlock loading rows={3} /> : (
          <div className={styles.blCol}>
            <div className={"stat-inline " + styles.blStrip}>
              <div>
                <div className="tiny">跳过</div>
                <div className={"mono " + styles.blNum + " " + styles.blNumWarn}>{fmtNum(backlog?.skippedSessions)}</div>
                <div className="tiny">{fmtNum(backlog?.skippedMessages)} 条消息未提炼</div>
              </div>
              <div>
                <div className="tiny">待处理</div>
                <div className={"mono " + styles.blNum + " " + styles.blNumPlain}>{fmtNum(backlog?.pendingSessions)}</div>
                <div className="tiny">{fmtNum(backlog?.pendingMessages)} 条消息</div>
              </div>
              <div>
                <div className="tiny">失败</div>
                <div className={"mono " + styles.blNum + " " + ((backlog?.failedSessions || 0) > 0 ? styles.blNumCrit : styles.blNumPlain)}>
                  {fmtNum(backlog?.failedSessions)}
                </div>
                <div className="tiny">处理中 {fmtNum(backlog?.processingSessions)}</div>
              </div>
            </div>
            <div className={"tiny " + styles.blNote}>
              跳过多为消息数过少的会话 (如单条消息)。想看清"数据欠债"的全貌, 去
              <a href="/lineage" className={styles.blLink}>数据血脉</a>
              页查看按智能体的积压分布。
            </div>
          </div>
        )}
      </PanelCard>
    </div>
  );
}