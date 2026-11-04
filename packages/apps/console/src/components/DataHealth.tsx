"use client";
// 2026-10-25 R8：数据健康固定槽位（CLS 修复）
// 为什么不是 Alert：Alert 是"有故障才出现"，出现时下面整块下移；探针实测单次位移 0.044。
// 这里槽位常驻、高度固定，内容在健康/降级之间切换但不再影响布局。
import Icon from "@/components/Icon";

export default function DataHealth({ failures, warnings, sample }: {
  failures: number;
  warnings: string[];
  sample?: string;
}) {
  const bad = failures > 0 || warnings.length > 0;
  const count = failures + warnings.length;
  const raw = [sample, ...warnings].filter(Boolean).join("；").slice(0, 400);
  return (
    <div className="data-health" data-state={bad ? "warn" : "ok"}>
      <Icon name={bad ? "alert" : "check"} size={16} />
      <span className="dh-text">
        {bad
          ? `有 ${count} 项数据没取到，页面其余部分照常可用`
          : "数据完整：本次取数全部成功"}
      </span>
      {bad ? (
        <details className="tech-detail dh-detail">
          <summary>技术详情</summary>
          <code>{raw || "（无更多信息）"}</code>
        </details>
      ) : null}
    </div>
  );
}
