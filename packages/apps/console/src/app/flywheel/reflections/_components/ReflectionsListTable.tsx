"use client";
// reflections 页 · 反思列表 (点击行展开详情) (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批6：裸表格清零 —— 改用同族底层 primitives.Table（支持 expandable/onRow）；
//   9 处内联 style 清零，chipStyle() 的内联对象也换成 .module.css 的类 + data-on 属性选择器。
//   为什么不走白名单 DataTable：本表必须「点行在下一行原地展开详情」，白名单 DataTable 目前没有
//   expandable；而登记例外 E1 的那层 DataTable 薄封装（components/common 子目录）已用满 10 个文件、
//   只减不增，不能再加第 11 个。故直接用 E1 薄封装所包的同族原子 Table：页面级表格标签归零，E1 仍为 10（本文件不新增 E1）。
//   行为等价：点击行展开/收起（同一时刻只展开一行，由 expandedId 控制）、展开区仍在被点行的下一行且整行通栏、
//   详情内容（ReflectionsDetail）与 onRelease 刷新逻辑、复制表格按钮位置均未变；列与字段一条不少。
//   键盘可达：展开按钮是原生 <button>（Tab 可聚焦、Enter/Space 生效、带 aria-expanded），
//   取代原来挂在 <tr> 上的 interactiveProps（tr 不再进 Tab 序列，改用标准披露按钮）。
//   取数与回调 props（rows / loading / expandedId / detail / onOpen / onReload）与文案未动。
import { t } from "@/i18n";
import { Table } from "@/components/primitives";
import type { TableColumn } from "@/components/primitives";
import type { Refl } from "./reflectionsShared";
import { badge, fmtTs } from "./reflectionsShared";
import { fmtPct } from "@/lib/format";
import ReflectionsDetail from "./ReflectionsDetail";
import TableCopyButton from "@/components/TableCopyButton";
import styles from "./ReflectionsListTable.module.css";

export default function ReflectionsListTable({
  rows,
  loading,
  expandedId,
  detail,
  onOpen,
  onReload,
}: {
  rows: Refl[];
  loading: boolean;
  expandedId: string | null;
  detail: Record<string, Refl>;
  onOpen: (id: string) => void;
  onReload: (id: string) => void;
}) {
  // 列：与改前表头逐列对应（主题/粒度/状态/覆盖率/遗漏/改进/更新时间）
  const columns: TableColumn<Refl>[] = [
    {
      key: "theme",
      title: "主题",
      render: (_v, r) => (
        <span className={styles.rltTheme} data-open={expandedId === r.theme}>{r.theme}</span>
      ),
    },
    {
      key: "granularity",
      title: "粒度",
      render: (_v, r) => (
        <span className={styles.rltChip} data-on={r.reflectionGranularity === "day"}>
          {r.reflectionGranularity === "day" ? "日结" : "主题"}
        </span>
      ),
    },
    { key: "status", title: "状态", render: (_v, r) => <span className={badge(r.status)}>{r.status}</span> },
    {
      key: "coverage",
      title: t('biz.coverage.col'),
      render: (_v, r) => (
        <span className={"mono " + styles.rltBase}>
          {r.coverageScore != null
            ? fmtPct(r.coverageScore) + (r.coverageDelta != null ? " (" + (r.coverageDelta >= 0 ? "+" : "") + fmtPct(r.coverageDelta) + ")" : "")
            : "-"}
        </span>
      ),
    },
    { key: "missed", title: "遗漏", render: (_v, r) => <span className={styles.rltBase}>{(r.missedTopics || []).length}</span> },
    { key: "improvements", title: "改进", render: (_v, r) => <span className={styles.rltBase}>{(r.improvements || []).length}</span> },
    {
      key: "updatedAt",
      title: "更新时间",
      render: (_v, r) => <span className={"nowrap mono " + styles.rltSm}>{fmtTs(r.updatedAt)}</span>,
    },
  ];

  return (
    <div className="panel"><div className="panel-header"><span className="panel-title">反思列表(点击行展开: 本体 / 审计 / 日结 / 派生任务回显)</span></div>
      <TableCopyButton />
      <Table<Refl>
        className={styles.rltTable}
        dataSource={rows}
        rowKey={(r) => r.theme}
        pagination={false}
        columns={columns}
        // 空态沿用改前文案：加载中… / 无
        locale={{ emptyText: loading ? "加载中…" : "无" }}
        onRow={(r) => ({ onClick: () => onOpen(r.theme), className: styles.rltRow })}
        expandable={{
          // 受控展开：expandedId 说开哪一行；按钮点开/点收与点击行走同一条通道（onOpen 内部判断"同 id = 收起"）
          expandedRowKeys: expandedId ? [expandedId] : [],
          onExpand: (_expanded, r) => onOpen(r.theme),
          expandedRowRender: (r) => (
            <div className={styles.rltDetail}>
              {detail[r.theme]
                ? <ReflectionsDetail refl={detail[r.theme]} fmtTs={fmtTs} onRelease={() => onReload(r.theme)} />
                : "加载详情…"}
            </div>
          ),
        }}
      />
    </div>
  );
}
