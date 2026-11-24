"use client";
// 0.6.1 U-39（设计 2026-11-17 18:19 确认稿 §2）：13 个二级入口下沉到父页顶部「功能入口」带，
//   侧栏只保留 27 个一级项。本组件为父页复用，数据来自 config/nav.ts 的 children（保留未删）。
import Link from "next/link";
import Icon from "@/components/Icon";
import styles from "./FeatureEntries.module.css";

export interface FeatureEntryItem {
  href: string;
  label: string;
  icon: string;
  desc?: string;
}

export default function FeatureEntries({ items, title = "功能入口" }: {
  items: FeatureEntryItem[];
  title?: string;
}) {
  if (!items || items.length === 0) return null;
  return (
    <section className={styles.wrap} aria-label={title}>
      <div className={styles.title}>{title}<span className={styles.count}>{items.length}</span></div>
      <div className={styles.grid}>
        {items.map((it) => (
          <Link key={it.href} href={it.href} className={styles.entry}>
            <span className={styles.icon} aria-hidden="true"><Icon name={it.icon} size={18} /></span>
            <span className={styles.body}>
              <span className={styles.label}>{it.label}</span>
              {it.desc ? <span className={styles.desc}>{it.desc}</span> : null}
            </span>
            <span className={styles.arrow} aria-hidden="true">›</span>
          </Link>
        ))}
      </div>
    </section>
  );
}