"use client";
// agents-live 页 · Agent 卡片网格 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批12（呈现层）：内联 style 清零（25 -> 0），下沉同目录 AgentCardGrid.module.css；
//   任务范围色 / 质量分档色 / 名下待办强调 / 失败数改 data-* 属性选择器。
//   本组件无数据卡（不属于卡 7），只改结构，不新增/不修改任何字段口径：取数、props 形状、文案、字段名一字未改。
import { Card, Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import { fmtNum, fmtScore, qualityTone, relTime } from "@/lib/format";
import { scopeDef, scopeOfType } from "@/config/taskScopes";
import { STATE_TONE, STATUS_TAG } from "./constants";
import styles from "./AgentCardGrid.module.css";

export default function AgentCardGrid({
  agents,
  loadingAll,
  stateRules,
  todoByAgent,
}: {
  agents: any[];
  loadingAll: boolean;
  stateRules: any;
  todoByAgent: Record<string, { open: number; done: number }>;
}) {
  return (
    <div className="card-grid cols-3">
      {loadingAll
        ? Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="panel-card" size="small">
              <StateBlock loading rows={3} />
            </Card>
          ))
        : agents.length === 0
          ? <PanelCard title={t('agentsLive.list.title')}><StateBlock title={t('agentsLive.list.empty')} rows={2} /></PanelCard>
          : agents.map((a: any) => (
              <Card
                key={a.agentId}
                className="panel-card"
                size="small"
                title={
                  <span className={styles.cardTitle}>
                    <span>{a.displayName}</span>
                    <span className="tiny mono">{a.agentId}</span>
                    {a.role === "executor" ? (
                      <Tooltip title="执行体身份：有工具但无常驻执行进程，不参与通信服务在线 / 离线判定；任务需人工或会话唤醒">
                        <span className={"pill warn " + styles.pillXs}>执行体</span>
                      </Tooltip>
                    ) : a.role === "assignee-only" ? (
                      <Tooltip title="该 id 只出现在任务字段里，未在通信服务 / 名册登记（可能已废弃或未接入）">
                        <span className={"pill mute " + styles.pillXs}>未接入</span>
                      </Tooltip>
                    ) : null}
                  </span>
                }
                extra={
                  <Tooltip
                    title={
                      <span>
                        {a.stateLabel}
                        <br />
                        {a.role === "executor"
                          ? stateRules?.executor
                          : a.state === "busy"
                            ? stateRules?.busy
                            : a.state === "stuck"
                              ? stateRules?.stuck
                              : a.state === "offline"
                                ? stateRules?.offline
                                : stateRules?.idle}
                        {a.stuckReason ? <><br />{a.stuckReason}</> : null}
                      </span>
                    }
                  >
                    <span><Pill tone={STATE_TONE[a.state] || "mute"}>{a.stateLabel}</Pill></span>
                  </Tooltip>
                }
              >
                <div className={styles.body}>
                  <div className={styles.metaRow}>
                    <Tag variant="filled">{a.channel || "未知渠道"}</Tag>
                    {a.host ? <Tag variant="filled">{a.host}</Tag> : null}
                    {a.role ? <Tag variant="filled" color={a.role === "ADMIN" ? "blue" : "default"}>{a.role}</Tag> : null}
                    <span className={"tiny " + styles.pushRight}>
                      最近露面 {a.lastSeenAt ? relTime(a.lastSeenAt) : "-"}
                    </span>
                  </div>

                  <div className={styles.section}>
                    <div className={"tiny " + styles.titleGap}>当前任务</div>
                    {a.currentTask ? (
                      <Tooltip title={a.currentTask.title}>
                        <div className={styles.baseText}>
                          <Tag color={STATUS_TAG[a.currentTask.status]?.color || "default"}>{STATUS_TAG[a.currentTask.status]?.label || a.currentTask.status}</Tag>
                          {(() => { const sd = scopeDef(a.currentTask.scope || scopeOfType(a.currentTask.improvementType)); return <span className={styles.scope} data-scope={sd.key}>{sd.short}</span>; })()}
                          {a.currentTask.title?.slice(0, 40)}
                        </div>
                        <div className="tiny">更新于 {relTime(a.currentTask.updatedAt)}</div>
                      </Tooltip>
                    ) : a.stuckReason ? (
                      <div className={styles.baseText + " " + styles.critText}>{a.stuckReason}</div>
                    ) : (
                      <div className="tiny">空闲, 没有进行中的任务</div>
                    )}
                    {a.assignedPendingCount ? (
                      <Tooltip title={t('agentsLive.assigned.tip')}>
                        <div className={"tiny " + styles.topSm}>已派单待开始 {fmtNum(a.assignedPendingCount)} 条</div>
                      </Tooltip>
                    ) : null}
                  </div>

                  <div className={styles.section}>
                    <div className={"tiny " + styles.titleGap}>最近提交 / 产出</div>
                    {a.lastExecution ? (
                      <div className={styles.baseText}>
                        <Tag color={a.lastExecution.status === "COMPLETED" ? "success" : "error"}>
                          {STATUS_TAG[a.lastExecution.status]?.label || a.lastExecution.status}
                        </Tag>
                        <span className="truncate">{a.lastExecution.taskTitle?.slice(0, 34) || "-"}</span>
                        <div className="tiny">{relTime(a.lastExecution.completedAt)}</div>
                      </div>
                    ) : (
                      <div className="tiny">窗口内没有执行记录</div>
                    )}
                    {a.lastOutput ? (
                      <div className={"tiny " + styles.topMd}>
                        最近产出质量 <b className={styles.qNum} data-tone={qualityTone(a.lastOutput.quality).cls}>{a.lastOutput.quality ?? "-"}</b> · {relTime(a.lastOutput.at)} · 窗口内共 {fmtNum(a.lastOutput.n)} 次提交
                      </div>
                    ) : null}
                  </div>

                  <div className={styles.statRow}>
                    <Tooltip title="改进任务口径 = 机制修复类 (GOAL_GAP + THEME_IMPROVE + PLATFORM_REVIEW)">
                      <span className="tiny">改进任务完成 <b className="mono">{fmtNum(a.taskStats?.done)}</b></span>
                    </Tooltip>
                    <span className="tiny">失败 <b className={"mono " + styles.failNum} data-tone={a.taskStats?.failed ? "crit" : undefined}>{fmtNum(a.taskStats?.failed)}</b></span>
                    <span className="tiny">执行 <b className="mono">{fmtNum(a.execStats?.n)}</b></span>
                    <span className={"tiny " + styles.pushRight}>
                      产出质量 <b className={"mono " + styles.qNum} data-tone={qualityTone(a.outputQuality).cls}>{a.outputQuality === null ? "-" : fmtScore(a.outputQuality)}</b>
                    </span>
                    {a.doneByScope ? (
                      <span className={"tiny " + styles.fullRow}>
                        窗口内完成拆分：
                        {["MECHANISM", "VERIFY", "DISCUSSION", "OTHER"]
                          .filter((k) => a.doneByScope[k])
                          .map((k) => `${scopeDef(k).short} ${a.doneByScope[k]}`)
                          .join(" · ") || "—"}
                      </span>
                    ) : null}
                    <span className={"tiny " + styles.fullRow}>
                      名下待办：
                      <Tooltip title={t('agentsLive.todo.tip')}>
                        <a href="/todo" className={styles.todoLink} data-open={(todoByAgent[a.agentId]?.open || 0) > 0 ? "true" : "false"}>
                          {fmtNum(todoByAgent[a.agentId]?.open || 0)} 条未完成
                        </a>
                      </Tooltip>
                      {todoByAgent[a.agentId]?.done ? <span className={styles.mutedText}>（已完成 {fmtNum(todoByAgent[a.agentId].done)}）</span> : null}
                    </span>
                  </div>
                </div>
              </Card>
            ))}
    </div>
  );
}
