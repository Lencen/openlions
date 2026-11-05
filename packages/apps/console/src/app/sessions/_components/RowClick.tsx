"use client";
/*
 * 行点击代理（P1 呈现层）—— 白名单 `DataTable` 只负责展示，没有 onRow/onClick 属性。
 * 按「不碰 components/」的约定，这里在页面层做事件委托：
 *   · 只认 <tbody> 里的数据行（空/错误态那一行是 .dt-state-row，跳过）；
 *   · 点在链接 / 按钮 / 输入框上时不触发 —— 行内次操作独立跳转。
 * 这样既保留了「整行可点」，也没有给共享 DataTable 加接口。
 */
import type { MouseEvent, ReactNode } from "react";

export default function RowClick({
  onPick,
  className,
  children,
}: {
  onPick: (index: number) => void;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    // .ui-dd 是行内「改派」下拉：点它的触发器/菜单项/遮罩都不算行点击（否则会顺带打开详情）。
    if (!target || target.closest("a,button,input,select,textarea,label,.ui-dd,[role=menu]")) return;
    const tr = target.closest("tbody tr") as HTMLTableRowElement | null;
    if (!tr || tr.classList.contains("dt-state-row")) return;
    const body = tr.parentElement;
    if (!body) return;
    const index = Array.prototype.indexOf.call(body.children, tr);
    if (index >= 0) onPick(index);
  };
  return (
    <div className={className} onClick={onClick}>
      {children}
    </div>
  );
}