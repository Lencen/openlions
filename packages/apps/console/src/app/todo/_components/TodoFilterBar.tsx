"use client";
// todo 页 · 筛选条 (状态标签 + 负责人 + 新建), 从 page.tsx 抽出
import { Button, Select } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PlusOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import FilterTabs from "@/components/common/FilterTabs";
import { t as tr } from "@/i18n";
import { TODO_STATUS } from "@/lib/todos";

const TABS = ["OPEN", "DOING", "BLOCKED", "DONE", "ALL"] as const;

export default function TodoFilterBar({
  tab,
  onTab,
  ownerFilter,
  onOwnerFilter,
  rowsCount,
  counts,
  loading,
  onCreate,
}: {
  tab: string;
  onTab: (key: string) => void;
  ownerFilter: string;
  onOwnerFilter: (v: string) => void;
  rowsCount: number;
  counts: Record<string, number>;
  /** 2026-10-13 round 76-CX: 数据还没回来时**不要显示计数** —— 原来会显示假的 0(实测和真实 0 条无法区分)。 */
  loading?: boolean;
  onCreate: () => void;
}) {
  const tabs = TABS.map((t) => ({
    key: t,
    label: t === "ALL" ? "全部" : TODO_STATUS[t]?.label || t,
    count: loading ? undefined : (t === "ALL" ? rowsCount : (counts[t] || 0)),
  }));
  return (
    <div className="panel-card ant-card">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
        <FilterTabs tabs={tabs} value={tab} onChange={onTab} />
        <span style={{ width: 1, height: 20, background: "var(--border)" }} />
        <Select
          ariaLabel="按负责人筛选"
          size="small"
          style={{ width: 150 }}
          value={ownerFilter}
          onChange={onOwnerFilter}
          options={[
            { value: "ALL", label: "全部负责人" },
            { value: "human", label: tr('todo.owner.human') },
            { value: "agent", label: tr('todo.owner.agent') },
          ]}
        />
        <span style={{ flex: 1 }} />
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onCreate}>新建待办</Button>
      </div>
    </div>
  );
}
