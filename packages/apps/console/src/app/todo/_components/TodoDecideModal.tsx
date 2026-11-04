"use client";
// todo 页 · "提交我的决定" 弹窗 (从 page.tsx 抽出)
// 2026-09-14 用户反馈: "这些需要人类执行的任务…我怎么完成了, 没有让我提交决策的地方呀"
//   实测: 行内只有"完成"按钮, 它把状态置 DONE 却**不记录决定内容** —— 对"人类决策/人审"类待办等于白点
//   (决定是什么、依据是什么, 全都丢了)。这里补一个显式的"提交我的决定"入口。
import { Input, Modal } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { truncate } from "@/lib/format";
import { HUMAN_ID } from "@/lib/todos";

export default function TodoDecideModal({
  decideRow,
  decideText,
  setDecideText,
  busy,
  onCancel,
  onOk,
}: {
  decideRow: any | null;
  decideText: string;
  setDecideText: (v: string) => void;
  busy: string | null;
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <Modal
      title={decideRow ? "提交我的决定 · " + String(decideRow.title || "").slice(0, 60) : "提交我的决定"}
      open={!!decideRow}
      onCancel={onCancel}
      onOk={onOk}
      okText="提交决定并留档"
      confirmLoading={!!decideRow && busy === decideRow.id}
      width={720}
    >
      {decideRow ? (
        <div>
          <div className="tiny" style={{ marginBottom: "var(--sp-2)", color: "var(--text-dim)" }}>
            来源 {decideRow.source || "-"} · 优先级 {decideRow.priority || "-"} · 负责人 {decideRow.ownerType}:{decideRow.ownerId || "未指派"}
          </div>
          {decideRow.detail ? (
            <div style={{ maxHeight: 220, overflow: "auto", background: "var(--bg-surface2, rgba(0,0,0,.03))", padding: "var(--sp-3)", borderRadius: "var(--radius-sm)", fontSize: "var(--fs-base)", whiteSpace: "pre-wrap", marginBottom: "var(--sp-3)" }}>
              {truncate(String(decideRow.detail), 1200)}
            </div>
          ) : null}
          <Input.TextArea
            rows={5}
            value={decideText}
            onChange={(e) => setDecideText(e.target.value)}
            placeholder="写下你的决定与依据, 例如: 采纳方案 B(先做 A-1 再做 A-2), 理由是…; 或 不采纳, 因为…。这段文字会作为证据永久留档。"
          />
          <div className="tiny" style={{ marginTop: "var(--sp-1-5)", color: "var(--text-dim)" }}>
            提交后：状态置为已完成 · 操作人：人工（{HUMAN_ID}） · 你的决定写入证据（平台按“有证据”口径统计）。
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
