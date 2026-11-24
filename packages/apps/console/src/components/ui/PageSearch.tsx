"use client";
/**
 * PageSearch —— 列表/页壳类页面的统一搜索框（0.6.3 U-27 P-06）
 *
 * 判据（设计 02:57）：input[type=search] + placeholder 含「搜索」
 * 用法：<PageSearch value={q} onChange={setQ} placeholder="搜索文档…" />
 * 页面可只用受控值 + 本地过滤，不必走后端。
 */
import styles from "./PageSearch.module.css";

export default function PageSearch({
  value,
  onChange,
  placeholder = "搜索…",
  label = "搜索",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor="page-search">{label}</label>
      <input
        id="page-search"
        type="search"
        className={styles.input}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {value ? (
        <button type="button" className={styles.clear} onClick={() => onChange("")} aria-label="清空搜索">
          ×
        </button>
      ) : null}
    </div>
  );
}