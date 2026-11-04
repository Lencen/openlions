"use client";
import Link from "next/link";
import type { MetricSpec } from "./types";
import { Pill, STATUS_META } from "./ui";

export default function MetricCard({ m, s }: { m: MetricSpec; s: any }) {
  const st = m.status(s);
  const meta = STATUS_META[st] || STATUS_META.info;
  return (
    <article className="panel" data-metric={m.key} data-status={st} style={{ padding: "var(--sp-3)", borderLeft: "3px solid " + meta.color, minWidth: 0 }}>
      <div className="tiny" style={{ color: "var(--text-muted)", minHeight: 18 }}>{m.label}</div>
      <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, lineHeight: 1.25, margin: "4px 0", overflowWrap: "anywhere" }}>{m.value(s)}</div>
      {m.sub ? <div className="tiny" style={{ color: "var(--text-dim)" }}>{m.sub(s)}</div> : null}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <Pill status={st} />
        {m.threshold ? <span className="tiny" style={{ color: "var(--text-muted)" }}>阈值 {m.threshold}</span> : null}
      </div>
      <div className="tiny" style={{ color: "var(--text-muted)", marginTop: 8, lineHeight: 1.55 }}>口径：{m.caliber}</div>
      <div className="tiny" style={{ color: "var(--text-muted)", lineHeight: 1.55 }}>来源：{m.source} · 责任人：{m.owner}</div>
      {m.note ? <div className="tiny" style={{ color: meta.color, marginTop: 4, lineHeight: 1.55 }}>{m.note}</div> : null}
      <div className="tiny" style={{ color: "var(--text-muted)", marginTop: 6, overflowWrap: "anywhere" }}>复算：<code>{m.verify}</code></div>
      {m.href ? <Link href={m.href} className="tiny" style={{ display: "inline-block", marginTop: 6 }}>下钻 →</Link> : null}
    </article>
  );
}
