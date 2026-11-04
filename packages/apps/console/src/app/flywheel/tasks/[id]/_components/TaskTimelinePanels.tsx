"use client";
// 任务详情页 · 状态流转 + 平台裁定 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Timeline } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import { fmtNum, relTime, truncate } from "@/lib/format";
import { VERDICT_LABEL } from "./constants";

export default function TaskTimelinePanels({ data }: { data: any }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <PanelCard title="状态流转" extra={<span className="tiny">{fmtNum(data?.transitions?.length ?? 0)} 次</span>}>
        {(data?.transitions ?? []).length === 0 ? (
          <StateBlock title="没有状态流转记录" rows={2} />
        ) : (
          <Timeline
            items={(data.transitions ?? []).map((tr: any) => ({
              color: tr.toStatus === "DONE" ? "green" : tr.toStatus === "FAILED" ? "red" : tr.toStatus === "DEPRECATED" ? "gray" : "blue",
              content: (
                <div style={{ fontSize: "var(--fs-base)" }}>
                  <div>
                    <b>{tr.fromStatus || "?"} → {tr.toStatus}</b>{" "}
                    <span className="actor-chip platform">{tr.actor || "platform"}</span>
                  </div>
                  {tr.reason ? <div className="tiny" style={{ whiteSpace: "pre-wrap", marginTop: "var(--sp-0-5)" }}>{truncate(tr.reason, 260)}</div> : null}
                  <div className="tiny">{relTime(tr.createdAt)}</div>
                </div>
              ),
            }))}
          />
        )}
      </PanelCard>

      <PanelCard title="平台裁定 / 人类干预" tone="var(--status-warn)">
        {(data?.verdicts ?? []).length === 0 ? (
          <StateBlock title="该任务还没有裁定记录" rows={2} />
        ) : (
          (data.verdicts ?? []).map((v: any) => (
            <div key={v.id} style={{ borderBottom: "1px solid var(--border)", padding: "var(--sp-1-5) 0", fontSize: "var(--fs-base)" }}>
              <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
                <Pill tone={v.stage === "KNOWLEDGE_REJECTED" ? "crit" : v.stage === "HUMAN_INTERVENTION" ? "warn" : "ok"}>
                  {VERDICT_LABEL[v.stage] || v.stage}
                </Pill>
                <span className="tiny">{v.sourceType}</span>
                <span className="tiny" style={{ marginLeft: "auto" }}>{relTime(v.at)}</span>
              </div>
              <div className="tiny" style={{ marginTop: "var(--sp-0-5)", whiteSpace: "pre-wrap" }}>{truncate(v.title, 200)}</div>
            </div>
          ))
        )}
      </PanelCard>
    </div>
  );
}
