"use client";
/**
 * CommandPalette.tsx — 平台命令面板（⌘K / Ctrl+K）
 *
 * 2026-10-22 新建。此前 ⌘K 被两处监听抢（GlobalSearch 的全局搜索、MessagesLayout 的会话搜索），
 * 在 /messages 上谁先冒泡谁赢，行为不稳定。现在收敛成**唯一入口**：
 *   - 页面导航（静态路由表）
 *   - 会话跳转（读 /api/macs/conversations，选中后走深链 /messages?conversation=）
 *   - 主题切换（light/dark/hc）
 * 键盘：↑↓ 选择、Enter 执行、Esc 关闭；aria 用 combobox/listbox/option。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Item = { id: string; label: string; hint?: string; group: string; run: () => void };

const PAGES: Array<{ label: string; href: string; hint: string }> = [
  { label: "总览", href: "/", hint: "平台总览" },
  { label: "待办中心", href: "/todo", hint: "人工待办 / 审核" },
  { label: "会话", href: "/messages", hint: "通信会话与消息" },
  { label: "会话线", href: "/messages/session", hint: "本线未确认 / 传输状态" },
  { label: "失败消息", href: "/messages/failed", hint: "未送达 / 重试" },
  { label: "消息管理", href: "/messages/manage", hint: "批量操作 / 导出" },
  { label: "飞轮", href: "/flywheel", hint: "增长飞轮" },
  { label: "成本", href: "/cost", hint: "用量与费用" },
  { label: "审计", href: "/audit", hint: "操作留痕" },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [convs, setConvs] = useState<Array<{ id: string; title?: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const close = useCallback(() => { setOpen(false); setQ(""); setActive(0); }, []);

  // 唯一 ⌘K 监听
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => {
          // 2026-10-22 修：重开时必须清空上次的关键词，否则会残留过滤条件导致"搜不到东西"
          if (!v) { setQ(""); setActive(0); }
          return !v;
        });
      } else if (e.key === "Escape") {
        // Esc 走 close()（同时清空关键词），与点遮罩关闭保持一致
        setOpen(false);
        setQ("");
        setActive(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    // 打开时拉一次会话列表（失败就只显示页面/主题项，不编造）
    fetch("/api/macs/conversations")
      .then((r) => r.json())
      .then((j) => setConvs(Array.isArray(j.conversations) ? j.conversations.slice(0, 30) : []))
      .catch(() => setConvs([]));
    return () => window.clearTimeout(t);
  }, [open]);

  const items: Item[] = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const out: Item[] = [];
    for (const p of PAGES) {
      if (kw && !(p.label + " " + p.hint).toLowerCase().includes(kw)) continue;
      out.push({ id: "page:" + p.href, label: p.label, hint: p.hint, group: "页面", run: () => router.push(p.href) });
    }
    for (const c of convs) {
      const title = c.title || c.id;
      if (kw && !title.toLowerCase().includes(kw)) continue;
      out.push({ id: "conv:" + c.id, label: title, hint: "打开会话", group: "会话", run: () => router.push("/messages?conversation=" + encodeURIComponent(c.id)) });
    }
    for (const t of ["light", "dark", "hc"] as const) {
      const label = t === "light" ? "浅色" : t === "dark" ? "深色" : "高对比";
      if (kw && !("主题 " + label).toLowerCase().includes(kw)) continue;
      out.push({ id: "theme:" + t, label: "主题：" + label, hint: "立即切换", group: "动作", run: () => document.documentElement.setAttribute("data-theme", t) });
    }
    return out;
  }, [q, convs, router]);

  useEffect(() => { setActive(0); }, [q]);

  if (!open) return null;
  const groups = Array.from(new Set(items.map((i) => i.group)));

  return (
    <div className="cmdk-mask" onClick={close}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          placeholder="搜索页面、会话或动作…（↑↓ 选择，Enter 打开，Esc 关闭）"
          aria-label="命令面板搜索"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); const it = items[active]; if (it) { it.run(); close(); } }
          }}
        />
        <div id="cmdk-list" className="cmdk-list" role="listbox">
          {items.length === 0 ? <div className="cmdk-empty">没有匹配项</div> : null}
          {groups.map((g) => (
            <div key={g} className="cmdk-group">
              <div className="cmdk-group-title">{g}</div>
              {items.filter((i) => i.group === g).map((it) => {
                const idx = items.indexOf(it);
                return (
                  <button
                    key={it.id}
                    type="button"
                    role="option"
                    aria-selected={idx === active}
                    className={"cmdk-item" + (idx === active ? " active" : "")}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => { it.run(); close(); }}
                  >
                    <span className="cmdk-item-label">{it.label}</span>
                    {it.hint ? <span className="cmdk-item-hint">{it.hint}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">⌘K 打开 · ↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}
