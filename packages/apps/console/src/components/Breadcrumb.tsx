"use client";
import Link from "next/link";

interface Crumb { label: string; href?: string; }

export default function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <div className="breadcrumb">
      {items.map((c, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          {i > 0 && <span className="sep">/</span>}
          {c.href ? <Link href={c.href}>{c.label}</Link> : <span className="current">{c.label}</span>}
        </span>
      ))}
    </div>
  );
}
