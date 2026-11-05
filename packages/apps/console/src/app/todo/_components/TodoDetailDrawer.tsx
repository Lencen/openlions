"use client";
// /todo · 详情抽屉（P1 试点页 ord-20261104-032）
// 改前：待办详情塞在表格行内展开（6–7 段格式化内容把列表撑成长文档，老板反馈「反人类」）。
// 改后：点行 → 右侧抽屉（Drawer），列表不动；?open=<id> 深链仍然有效。
// 本文件只搬呈现，TodoDetail 与 onDecide 的行为未改。
import { Drawer } from "@/components/primitives";
import TodoDetail from "@/components/TodoDetail";

export default function TodoDetailDrawer({
  row,
  onClose,
  onDecide,
}: {
  row: any | null;
  onClose: () => void;
  onDecide: (row: any, option?: { key: string; label: string }) => void;
}) {
  return (
    <Drawer
      open={row != null}
      onClose={onClose}
      title={row ? <span className="td-todo-drawer-title">{row.title || "待办详情"}</span> : ""}
      width={680}
      placement="right"
    >
      {row ? (
        <div className="td-todo-drawer">
          <div className="td-todo-meta">
            <span className="mono">{row.id}</span>
            {row.priority ? <span>优先级 {row.priority}</span> : null}
            {row.dueAt ? <span>截止 {String(row.dueAt).slice(0, 10)}</span> : null}
          </div>
          <TodoDetail todo={row} onDecide={onDecide} />
        </div>
      ) : null}
    </Drawer>
  );
}
