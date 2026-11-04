"use client";
// agents-live 页 · 指标卡行 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";
import { MetricCard } from "@/components/ui";
import { fmtNum, fmtScore } from "@/lib/format";

export default function AgentsLiveMetrics({
  s,
  loadingAll,
  agentTodoOpen,
}: {
  s: any;
  loadingAll: boolean;
  agentTodoOpen: number;
}) {
  return (
    <div className="metric-row">
      <MetricCard label={t('agentsLive.online')} tone="ok" value={loadingAll ? "…" : fmtNum(s.online)} unit="个" hint={`共 ${fmtNum(s.total)} 个登记`} />
      <MetricCard label={t('agentsLive.busy')} tone="info" value={loadingAll ? "…" : fmtNum(s.busy)} unit="个" hint={t('agentsLive.busy.hint')} />
      <MetricCard
        label="疑似卡住"
        tone={s.stuck ? "crit" : "mute"}
        value={loadingAll ? "…" : fmtNum(s.stuck)}
        unit="个"
        hint={s.stuck ? "需人工排查" : "无异常"}
      />
      <MetricCard
        label="24h 任务完成（全部类型）"
        tone="ok"
        value={loadingAll ? "…" : fmtNum(s.taskDoneAll)}
        unit="个"
        hint={<Tooltip title="所有改进类型的已完成任务数; 下面两张卡是它的拆分"><span>总口径</span></Tooltip>}
        footer={
          <span className="tiny">
            {s.taskDoneByType?.slice(0, 3).map((x: any) => `${x.type} ${x.count}`).join(" · ") || "-"}
          </span>
        }
      />
      <MetricCard
        label="改进任务完成（机制修复类）"
        tone="warn"
        value={loadingAll ? "…" : fmtNum(s.taskDone)}
        unit="个"
        hint={
          // 2026-10-21：机制类与全部类型相等时直说"当前窗口只有机制类"，别让两张卡显示同一个数还不解释。
          Number(s.taskDone) === Number(s.taskDoneAll) && Number(s.taskDoneAll) > 0
            ? <span>当前窗口内只有机制类（与左侧相同）</span>
            : <Tooltip title={s.taskScope?.note || "改进任务口径 = 机制修复类"}><span>目标缺口 + 主题改进 + 平台复审</span></Tooltip>
        }
        footer={<span className="tiny">{s.taskFailed ? `失败 ${fmtNum(s.taskFailed)}` : "无失败"}</span>}
      />
      <MetricCard
        label={t('agentsLive.agentType.label')}
        tone="info"
        value={loadingAll ? "…" : fmtNum(s.taskDoneAgentType)}
        unit="个"
        hint={<Tooltip title={t('agentsLive.verify.tip')}><span>独立复核类</span></Tooltip>}
        footer={<span className="tiny">对话/问答 {fmtNum(s.taskDoneDialogue)} 个另计 · 这三类都不算"改进任务"</span>}
      />
      <MetricCard
        label="执行记录"
        tone="info"
        value={loadingAll ? "…" : fmtNum(s.executions)}
        unit="次"
        hint={loadingAll ? "…" : `产出提交 ${fmtNum(s.submissions)} 次`}
      />
      <MetricCard
        label={t('agentsLive.token.label')}
        tone={(s.tokenUsage?.tokens || 0) > 0 ? "ok" : "mute"}
        // 2026-10-13 round 76-EC: 这张卡原来**整张都没守卫** —— 加载中显示「0 个智能体 · 0 次上报」(实测就绪后有数) ✗。
        //   同文件里前几张卡早就用 loadingAll 守卫了 -> 又是「同一组件内守卫不齐」。
        value={loadingAll ? "…" : fmtNum(s.tokenUsage?.tokens || 0)}
        unit={t('cost.unit')}
        hint={loadingAll ? "…" : t('agentsLive.token.footer', { n: fmtNum(s.tokenUsage?.agents || 0), m: fmtNum(s.tokenUsage?.calls || 0) })}
        footer={loadingAll ? <span className="tiny">…</span> : <span className="tiny">{s.tokenUsage?.note || t('agentsLive.token.noteDefault')}</span>}
      />
      <MetricCard
        label={t('agentsLive.todo.label')}
        // 2026-10-13 round 76-EC: 这张也是漏守卫的 —— 加载中显示「0条未完成」, 就绪后是 6(实测) ✗。
        tone={loadingAll ? "mute" : agentTodoOpen ? "warn" : "mute"}
        value={loadingAll ? "…" : fmtNum(agentTodoOpen)}
        unit="条未完成"
        hint={t('agentsLive.todo.hint')}
      />
      <MetricCard
        label="产出平均质量"
        tone={(s.avgQuality ?? 0) >= 0.7 ? "ok" : "warn"}
        value={loadingAll ? "…" : s.avgQuality === null || s.avgQuality === undefined ? "-" : fmtScore(s.avgQuality)}
        unit="/ 1.00"
        hint={t('agentsLive.quality.hint')}
      />
    </div>
  );
}
