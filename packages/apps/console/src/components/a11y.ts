/**
 * a11y.ts — 让"可点击的行/卡片"也能被键盘使用 (2026-10-13 round 76-BA)
 *
 * 背景: 控制台里大量 `<tr onClick>` / `<div style={{cursor:"pointer"}} onClick>` 用于展开详情,
 *   但它们**没有 tabIndex**, 键盘用户根本 Tab 不到、也无法 Enter/Space 触发(鼠标专用)。
 *
 * 用法: <tr {...interactiveProps(isOpen)} onClick={...}>
 *   - 不加 role="button": `<tr>` 加 role 会**破坏表格语义**(屏幕阅读器不再当它是行);
 *     这里只补 tabIndex(进 Tab 序列) + Enter/Space 触发 + aria-expanded。
 *   - 复用元素自身的 onClick: keydown 里直接 `.click()`, 不必把 handler 传进来。
 */
import type { KeyboardEvent } from "react";

export function interactiveProps(expanded?: boolean) {
  return {
    tabIndex: 0,
    ...(expanded === undefined ? {} : { "aria-expanded": expanded }),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        (e.currentTarget as HTMLElement).click();
      }
    },
  };
}
