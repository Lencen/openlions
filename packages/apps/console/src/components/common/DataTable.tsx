"use client";
// 公共控件 (2026-09-14 页面瘦身): 统一小尺寸表格。
// 抽取动机: cost / lineage / flywheel 等页面反复写 `size="small" pagination={false}` +
// 手搓 `locale={{ emptyText: <StateBlock .../> }}`, 这里收敛为默认值, 页面只传 columns/dataSource。
import { Table } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { TableProps } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { StateBlock } from "@/components/ui";

export type DataTableProps<T> = TableProps<T> & {
  /** 空态标题 (默认沿用 StateBlock 的"暂无数据") */
  emptyTitle?: string;
  /** 空态骨架行数 */
  emptyRows?: number;
};

export default function DataTable<T extends object>({
  size = "small",
  pagination = false,
  emptyTitle,
  emptyRows = 2,
  locale,
  ...rest
}: DataTableProps<T>) {
  return (
    <Table<T>
      size={size}
      pagination={pagination}
      locale={{ emptyText: <StateBlock title={emptyTitle} rows={emptyRows} />, ...(locale || {}) }}
      {...rest}
    />
  );
}
