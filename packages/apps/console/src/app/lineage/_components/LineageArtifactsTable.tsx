"use client";
// lineage 页 · 产物血缘浏览器 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import DataTable from "@/components/common/DataTable";
import { PanelCard } from "@/components/ui";
import { fmtNum, fmtScore, qualityTone, relTime, shortId, truncate } from "@/lib/format";
import { TABLE_COLOR, TABLE_LABEL, VERIFY_TAG } from "./lineageShared";
import { inkOf } from "@/lib/ink";

export default function LineageArtifactsTable({
  artifacts,
  loadingAll,
  onSelect,
}: {
  artifacts: any[];
  loadingAll: boolean;
  onSelect: (sel: { type: string; id: string }) => void;
}) {
  return (
    <PanelCard
      title="产物血缘（点击查看来源与去向）"
      // 2026-10-13 round 76-DY: 加载中 artifacts 还是空数组 -> 会显示「窗口内最近 0 条」(实测就绪后 24 条) -> 假空计数。
      extra={<span className="tiny">窗口内最近 {loadingAll ? "…" : fmtNum(artifacts.length)} 条</span>}
    >
      <DataTable
        rowKey={(row: any) => row.table + ":" + row.id}
        loading={loadingAll}
        pagination={{ pageSize: 12, size: "small", showSizeChanger: false }}
        dataSource={artifacts}
        emptyTitle="窗口内没有新增产物, 换个时间范围试试"
        emptyRows={2}
        onRow={(row: any) => ({ onClick: () => onSelect({ type: row.table, id: row.id }), className: "clickable-row" })}
        columns={[
          {
            title: "类型",
            dataIndex: "table",
            width: 76,
            render: (v: string) => <span style={{ color: inkOf(TABLE_COLOR[v]), fontWeight: 600, fontSize: "var(--fs-base)" }}>{TABLE_LABEL[v] || v}</span>,
          },
          {
            title: "产物",
            dataIndex: "title",
            render: (v: string, row: any) => (
              <Tooltip title={v}>
                <span style={{ fontSize: "var(--fs-base)" }}>{truncate(v, 46)}</span>
                <div className="tiny mono">{shortId(row.id)}</div>
              </Tooltip>
            ),
          },
          {
            title: "来源",
            dataIndex: "sourceType",
            width: 200,
            render: (v: string, row: any) => (
              <div style={{ fontSize: "var(--fs-sm)" }}>
                <div>{v || <span className="tiny">未标注</span>}</div>
                {row.sourceId ? <div className="tiny mono">{shortId(row.sourceId, 10, 4)}</div> : null}
              </div>
            ),
          },
          {
            title: "质量",
            dataIndex: "qualityScore",
            width: 76,
            render: (v: number) => {
              const q = qualityTone(v);
              return <span style={{ color: q.color, fontFamily: "var(--font-mono)", fontSize: "var(--fs-base)" }}>{v ? fmtScore(v) : "-"}</span>;
            },
          },
          {
            title: "验证",
            dataIndex: "verification",
            width: 100,
            render: (v: string, row: any) =>
              v ? <Tag color={VERIFY_TAG[v]?.color || "default"}>{VERIFY_TAG[v]?.label || v}</Tag> : <span className="tiny">{row.humanConfirmed ? "人工确认" : "未验证"}</span>,
          },
          { title: "创建", dataIndex: "createdAt", width: 80, render: (v: number) => <span className="tiny nowrap">{relTime(v)}</span> },
        ]}
      />
    </PanelCard>
  );
}
