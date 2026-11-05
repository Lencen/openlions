"use client";
// 概览首页 · 核心 6 指标 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";
import { MetricCard } from "@/components/ui";
import { fmtCompact, fmtNum, fmtScore, fmtTokens } from "@/lib/format";
import { TABLE_LABEL } from "./constants";
import styles from "../page.module.css";

const INK: Record<string, string> = {
  Memory: styles.inkMemory,
  Knowledge: styles.inkKnowledge,
  Practice: styles.inkPractice,
  Skill: styles.inkSkill,
};

export default function OverviewMetrics({ data, loadingCards }: { data: any; loadingCards: boolean }) {
  const s = data?.sessions;
  const prod = data?.products;
  const tasks = data?.tasks;
  const agents = data?.agents;
  const tokens = data?.tokens;
  const quality = data?.quality;

  return (
    <div className="metric-row">
      <MetricCard
        label="今日会话流入"
        tone="info"
        value={loadingCards ? "…" : fmtNum(s?.newSessions)}
        unit="个会话"
        hint={fmtNum(s?.inflowMessages) + " 条消息"}
        trend={s?.trend}
        footer={
          <>
            <span>活跃会话 {fmtNum(s?.activeSessions)}</span>
            <span className="tiny">· 已完成提炼 {fmtNum(s?.extractedSessions)}</span>
          </>
        }
      />
      <MetricCard
        label="提炼产物量"
        tone="ok"
        value={loadingCards ? "…" : fmtNum(prod?.total)}
        unit="条"
        hint="记忆 + 知识 + 实践 + 技能"
        trend={prod?.trend}
        footer={
          <>
            {(["Memory", "Knowledge", "Practice", "Skill"] as const).map((t) => (
              <span key={t} className="tiny">
                <span className={styles.inkStrong + " " + (INK[t] || "")}>{TABLE_LABEL[t]}</span> {fmtNum(prod?.byTable?.[t]?.n)}
              </span>
            ))}
          </>
        }
      />
      <MetricCard
        label="改进任务完成 / 失败"
        tone={tasks?.failed > 0 ? "warn" : "info"}
        value={loadingCards ? "…" : fmtNum(tasks?.done)}
        unit="个已完成"
        hint={
          <Tooltip title={`口径: ${tasks?.scope?.note || "机制修复类"}; 验证/对话任务不计入`}>
            <span>机制修复类</span>
          </Tooltip>
        }
        trend={tasks?.trend}
        footer={
          <>
            <span>进行中 {fmtNum(tasks?.running)}</span>
            <span className="tiny">· 待执行 {fmtNum(tasks?.pending)}</span>
            {tasks?.byScope ? (
              <span className="tiny">
                · 另有 验证 {fmtNum(tasks.byScope.VERIFY?.all)} / 对话 {fmtNum(tasks.byScope.DISCUSSION?.all)} 不计入
              </span>
            ) : null}
          </>
        }
      />
      <MetricCard
        label={t('overview.activeAgent')}
        tone="info"
        value={loadingCards ? "…" : fmtNum(agents?.withTasks)}
        unit="个在干活"
        hint={`注册 ${fmtNum(agents?.total)} · 启用 ${fmtNum(agents?.active)}`}
        trend={agents?.trend}
        footer={<span className="tiny">{t('overview.activeAgent.hint')}</span>}
      />
      <MetricCard
        label={t('overview.token.label')}
        tone="warn"
        value={loadingCards ? "…" : fmtCompact(tokens?.total)}
        unit="词元"
        hint={t('overview.token.calls', { n: fmtNum(tokens?.totalCalls) })}
        trend={tokens?.trend}
        footer={
          <>
            <span>实测 {fmtTokens(tokens?.measuredTokens)}</span>
            {tokens?.estimatedTokens ? (
              <Tooltip title="tok≈N 估算值, 单列展示, 不计入总量">
                <span className={"tiny " + styles.warnText}>{t('overview.token.estimated', { v: fmtTokens(tokens.estimatedTokens) })}</span>
              </Tooltip>
            ) : null}
            {tokens?.callsUnmeasured ? (
              <Tooltip title={t('overview.token.unmeasuredTip')}>
                <span className={"tiny " + styles.warnText}>{t('overview.token.unmeasured', { n: fmtNum(tokens.callsUnmeasured) })}</span>
              </Tooltip>
            ) : null}
          </>
        }
      />
      <MetricCard
        label="产物质量分"
        tone={(quality?.overall ?? 0) >= 0.6 ? "ok" : "warn"}
        value={loadingCards ? "…" : fmtScore(quality?.overall)}
        unit="/ 1.00"
        hint={`${fmtNum(quality?.scoredTotal)} 条有评分`}
        footer={
          <>
            {(["Memory", "Knowledge", "Practice", "Skill"] as const).map((t) => (
              <span key={t} className="tiny">
                <span className={styles.inkStrong + " " + (INK[t] || "")}>{TABLE_LABEL[t]}</span> {fmtScore(quality?.byTable?.[t]?.avg)}
              </span>
            ))}
          </>
        }
      />
    </div>
  );
}