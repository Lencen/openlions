"use client";
import type { ActionSpec } from "./types";
import { Panel, SimpleTable, Note, Pill } from "./ui";
import styles from "../page.module.css";

export default function ActionList({ actions, s, title = "本维度红色动作" }: { actions: ActionSpec[]; s: any; title?: string }) {
  return (
    <Panel title={title} extra="指标 → 责任人 → 阈值 → 动作 → 复算">
      {actions.length ? (
        <SimpleTable
          head={["状态", "指标", "当前", "阈值", "责任人", "第一动作", "复算"]}
          rows={actions.map((a) => [
            <Pill key={a.key} status={a.status(s)} />,
            a.metric,
            a.current(s),
            a.threshold,
            a.owner,
            <span key={"act" + a.key} className="tiny">{a.action}{a.note ? <span className={styles.noteMuted}>（{a.note}）</span> : null}</span>,
            <code key={"v" + a.key}>{a.verify}</code>,
          ])}
        />
      ) : <Note>本维度当前没有红色动作；仍需按阈值定期复核，避免“绿了就没人看”。</Note>}
    </Panel>
  );
}
