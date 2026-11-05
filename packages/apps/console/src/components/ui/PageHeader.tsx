"use client";
/**
 * PageHeader / PageTitle — 白名单组件（P0）
 * ---------------------------------------------------------------------------
 * 兼容两种用法：
 *   ① 组合式（存量 55 处）：<PageHeader style={...}><PageTitle>接入审批</PageTitle>…</PageHeader>
 *   ② 直接传样式/类名：<PageHeader className="…" style={…}>
 * 规则：页面不得自写 <h1> 或 page-title 层级，必须走这两个组件。
 */
import type { CSSProperties, ReactNode } from "react";

export interface PageHeaderProps {
  children?: ReactNode;
  /** 透传到容器（存量调用方会传 flex 布局） */
  style?: CSSProperties;
  className?: string;
}

export interface PageTitleProps {
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function PageHeader({ children, style, className }: PageHeaderProps) {
  return (
    <div className={className ? "page-header " + className : "page-header"} style={style}>
      {children}
    </div>
  );
}

export function PageTitle({ children, style, className }: PageTitleProps) {
  return (
    <div className={className ? "page-title " + className : "page-title"} style={style}>
      {children}
    </div>
  );
}

export default PageHeader;
