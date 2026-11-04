"use client";
// ListControls: 列表通用工具条 (搜索框 + 快速筛选 + 时间排序 + 分页)
// 所有认知列表页共用, 保证交互一致:
// - 排序: 创建时间 / 更新时间, 默认更新时间倒序 (后端默认 sortBy=updatedAt&sortOrder=desc)
// - 搜索: keyword 触发 search 参数 (后端 LIKE 模糊)
// - 分页: 上一页/下一页 + 当前页 + 总数
// - 快速筛选 (2026-09-14 UI-7): 高质量 / 近 7 天 / 被引用过 / 待复核, 由页面按表能力传入
import { t } from "@/i18n";
import type { QuickFilterOption } from "@/config/cognitiveQuickFilters";

interface Props {
  search?: string;
  onSearch: (v: string) => void;
  sortBy: string;
  onSortBy: (v: string) => void;
  sortOrder: string;
  onSortOrder: (v: "asc" | "desc") => void;
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  hasUpdatedAt?: boolean; // false = 无 updatedAt 的表, 只提供创建时间排序
  quickFilters?: QuickFilterOption[]; // 该表支持的常用筛选入口 (空/未传则不渲染该行)
  quick?: string | null;
  onQuick?: (key: string | null) => void;
  /** 2026-10-13 round 76-DR: 加载中时不要显示「共 0 条」—— 那是**假空计数**
   *  (实测 /cognitive/knowledge 等页加载中显示 `1 / 1 · 共 0 条`, 就绪后才是真实总数)。 */
  loading?: boolean;
}

export default function ListControls(p: Props) {
  const totalPages = Math.max(1, Math.ceil((p.total || 0) / p.pageSize));
  const quickFilters = p.quickFilters ?? [];
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: "var(--sp-2-5)", alignItems: "center", flexWrap: "wrap", padding: "var(--sp-3) var(--sp-4)" }}>
        <input
          value={p.search ?? ""}
          onChange={(e) => p.onSearch(e.target.value)}
          placeholder="搜索..."
          style={{ flex: 1, minWidth: 160, padding: "var(--sp-1-5) var(--sp-2-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text)", fontSize: "var(--fs-base)" }}
        />
        <select
          value={p.sortBy}
          onChange={(e) => p.onSortBy(e.target.value)}
          style={{ padding: "var(--sp-1-5) var(--sp-2)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text)", fontSize: "var(--fs-base)" }}
          aria-label="排序字段"
        >
          <option value="updatedAt">{p.hasUpdatedAt === false ? "更新时间(不可用)" : "更新时间"}</option>
          <option value="createdAt">创建时间</option>
        </select>
        <select
          value={p.sortOrder}
          onChange={(e) => p.onSortOrder(e.target.value as "asc" | "desc")}
          style={{ padding: "var(--sp-1-5) var(--sp-2)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text)", fontSize: "var(--fs-base)" }}
          aria-label="排序方向"
        >
          <option value="desc">↓ 倒序</option>
          <option value="asc">↑ 正序</option>
        </select>
        <div style={{ display: "flex", gap: "var(--sp-1-5)", alignItems: "center" }}>
          <button className="ui-btn" disabled={p.page <= 1} onClick={() => p.onPage(p.page - 1)}>‹ 上一页</button>
          <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{p.loading ? "… / … · 共 … 条" : `${p.page} / ${totalPages} · 共 ${p.total?.toLocaleString?.() ?? p.total} 条`}</span>
          <button className="ui-btn" disabled={p.page >= totalPages} onClick={() => p.onPage(p.page + 1)}>下一页 ›</button>
        </div>
      </div>
      {quickFilters.length > 0 && (
        <div data-testid="quick-filters" style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap", padding: "0 var(--sp-4) var(--sp-3)" }}>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{t("quick.group")}</span>
          {quickFilters.map((f) => {
            const active = p.quick === f.key;
            return (
              <button
                key={f.key}
                type="button"
                data-quick={f.key}
                aria-pressed={active}
                title={f.tip}
                onClick={() => p.onQuick?.(active ? null : f.key)}
                className="ui-btn"
                style={active ? { borderColor: "var(--primary)", color: "var(--primary)", background: "var(--primary-dim)", fontWeight: 600 } : undefined}
              >
                {active ? "✓ " : ""}{f.label}
              </button>
            );
          })}
          {p.quick && (
            <button type="button" data-quick-clear onClick={() => p.onQuick?.(null)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--text-dim)", fontSize: "var(--fs-sm)", textDecoration: "underline" }}>
              {t("quick.clear")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
