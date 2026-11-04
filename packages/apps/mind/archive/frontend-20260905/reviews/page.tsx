"use client";

export const dynamic = "force-dynamic";

// 遗留#8 (2026-09-01): review tRPC router 已不存在 (历史移除), 页面改为静态占位
//   待 selfimproving 的 ReviewRecord 接入 mind 后再恢复列表
export default function ReviewsPage() {
  return (
    <div style={{ padding: 48, textAlign: "center", color: "#94a3b8" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>评审队列</h1>
      <p>评审功能暂未接入 (ReviewRecord 在 selfimproving 侧, 待桥接)</p>
    </div>
  );
}