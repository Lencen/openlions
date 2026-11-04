"use client";
// cost 页 · 统计口径说明 + 页脚 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { PanelCard } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum } from "@/lib/format";

export default function CostCaliber({ data }: { data: any }) {
  return (
    <>
      <PanelCard title="统计口径" extra={<span className="tiny">可直接核对</span>}>
        <div style={{ fontSize: "var(--fs-base)", lineHeight: 1.9, color: "var(--text-dim)" }}>
          <div>· <b>用量总量（实测）</b> = 窗口内所有实测调用事件的用量之和（不含仅记录字符数与空记录）。</div>
          <div>· <b>估算用量单列</b>：估算值由管理侧根据提示词长度推算，与实测分开统计，<b>不计入总量</b>；页面上的「估算（未并入）」列即为该口径，「参考合计」只作展示。</div>
          <div>· <b>未计量调用</b> = 事件标题为 <code>字符数估算</code> 或空的事件数（这些调用只统计次数，不计用量）。</div>
          <div>· <b>单次平均用量</b> = 用量总量 ÷ 已计量调用次数。</div>
          <div>· <b>平均耗时</b> = 事件来源记录里的耗时（单位毫秒）。</div>
          <div>· <b>不做金额折算</b>：平台不保存单价，因此页面只呈现用量数量，不出现任何费用数字。</div>
          <div>· <b>归因主体</b>：<b>来源类型</b>为 <code>平台:&lt;入口&gt;</code> 的是平台侧调用（按其模型聚合）；<b>来源类型</b>以 <code>智能体:</code> 开头的是<b>智能体自报用量</b>（智能体提交时自带用量上报，来源编号 = 任务编号），因此用量可以真实按智能体拆分——“按智能体聚合”表 / 图就是这条链路的数据。</div>
          <div>· <b>模型归因</b>：优先取事件标题里自带的模型标注（实测，当前窗口 {fmtNum(data?.modelRecordedCalls)} 次带该标注）；老事件没有该标注时，平台侧按入口路由推定，智能体侧标记为智能体上报的模型。</div>
        </div>
      </PanelCard>

      <div className="tiny" style={{ textAlign: "right" }}>
        {t("cost.source")}{" "}
        {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
      </div>
    </>
  );
}
