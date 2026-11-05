"use client";
// Breadcrumb · P2 呈现层（批1）：内联样式清零（每一段的横排对齐改由 Breadcrumb.module.css 的 .crumb 承担）。
import Link from "next/link";
import styles from "./Breadcrumb.module.css";

interface Crumb { label: string; href?: string; }

export default function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <div className="breadcrumb">
      {items.map((c, i) => (
        <span key={i} className={styles.crumb}>
          {i > 0 && <span className="sep">/</span>}
          {c.href ? <Link href={c.href}>{c.label}</Link> : <span className="current">{c.label}</span>}
        </span>
      ))}
    </div>
  );
}
