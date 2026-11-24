"use client";
// B5 system 余 11 页共用小件（2026-11-15）
// 约束：只读；不改共享组件（components/* 只 import）；四态真实取数 + ?state= 强制态（供截图/判据）；
// 字体只用 12/13/14/16/20/24/30 档；按钮可点目标 >=24px（WCAG 2.2 AA）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import BentoCard from "@/components/bento/BentoCard";
import BentoKpi from "@/components/bento/BentoKpi";
import BentoState from "@/components/bento/BentoState";
import type { Metric } from "@/components/bento/types";
import styles from "./bento-kit.module.css";

export type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

const PHASES = ["loading", "empty", "error", "unavailable", "forbidden", "ok"] as const;

/** 四态预览：?state=loading|empty|error|unavailable|forbidden 强制渲染对应态（真实取数不伪造数据）。 */
export function usePhaseOverride(): Phase | null {
  const [o, setO] = useState<Phase | null>(null);
  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get("state");
      if (v && (PHASES as readonly string[]).includes(v)) setO(v as Phase);
    } catch { /* noop */ }
  }, []);
  return o;
}

export interface Resource<T> {
  data: T | null;
  phase: Phase;
  error: string;
  status: number | null;
  reload: () => void;
}

/** 统一取数：loading/ok/empty/error/forbidden；空集与不可得分开（不把取不到当 0）。 */
export function useResource<T>(
  url: string,
  opts?: { emptyWhen?: (d: T) => boolean; pollMs?: number }
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const emptyRef = useRef<((d: T) => boolean) | undefined>(undefined);
  emptyRef.current = opts?.emptyWhen;
  const pollMs = opts?.pollMs ?? 0;
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!alive) return;
        setStatus(res.status);
        if (res.status === 401 || res.status === 403) { setPhase("forbidden"); return; }
        if (!res.ok) { setError("返回码 " + res.status); setPhase("error"); return; }
        const j = (await res.json()) as T;
        if (!alive) return;
        setData(j);
        setError("");
        setPhase(emptyRef.current && emptyRef.current(j) ? "empty" : "ok");
      } catch {
        if (!alive) return;
        setError("网络不可达或响应不是 JSON");
        setPhase("error");
      }
    };
    setPhase("loading");
    load();
    if (!pollMs) return () => { alive = false; };
    const timer = setInterval(() => { if (!document.hidden) load(); }, pollMs);
    return () => { alive = false; clearInterval(timer); };
  }, [url, nonce, pollMs]);
  return { data, phase, error, status, reload };
}

/** 页头 chips 4：# / 组 / 子页 / 只读（写页才传 readonly=false）。 */
export function Chips({ group, page, readonly = true }: { group: string; page: string; readonly?: boolean }) {
  return (
    <div className={styles.chips} aria-label="页面层级">
      <span>#</span><span>{group}</span><span>{page}</span>
      <span className={styles.crumbOn}>{readonly ? "只读" : "编辑"}</span>
    </div>
  );
}

/** KPI 卡（BentoCard + BentoKpi）：span 默认 3，可 3/4/6。 */
export function KpiTile({ span = 3, label, metric }: { span?: number; label: ReactNode; metric: Metric }) {
  return (
    <BentoCard span={span}>
      <BentoKpi label={label} metric={metric} />
    </BentoCard>
  );
}

/** 工具条：左筛选/搜索，右只读说明。 */
export function Toolbar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.tools}>{children}</div>
      <span className={styles.spacer} />
      {right ? <span className={styles.toolRight}>{right}</span> : null}
    </div>
  );
}

export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      className={styles.search}
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function FilterBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={on ? styles.fbtnOn : styles.fbtn} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

export function Pager({ page, pages, totalText, onPage }: { page: number; pages: number; totalText: ReactNode; onPage: (p: number) => void }) {
  return (
    <div className={styles.pager}>
      <span className={styles.pageInfo}>{totalText}</span>
      <span className={styles.pageBtns}>
        <button type="button" className={styles.pbtn} disabled={page <= 0} onClick={() => onPage(page - 1)}>上一页</button>
        <span className={styles.pageNow}>{page + 1} / {pages}</span>
        <button type="button" className={styles.pbtn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>下一页</button>
      </span>
    </div>
  );
}

export function Note({ children, tone }: { children: ReactNode; tone?: "warn" | "mute" }) {
  return <p className={styles.note} data-tone={tone || "mute"}>{children}</p>;
}

export function Tone({ tone, children }: { tone: "ok" | "warn" | "crit" | "info" | "mute"; children: ReactNode }) {
  const cls = tone === "ok" ? "badge badge-green" : tone === "warn" ? "badge badge-yellow" : tone === "crit" ? "badge badge-red" : tone === "info" ? "badge badge-blue" : "badge";
  return <span className={cls}>{children}</span>;
}

/** 四态统一渲染（含端点+HTTP 状态码+重试；中文文案，不显示原始异常串）。 */
export function States({
  phase, endpoint, error, status, onRetry, emptyTitle, emptyDetail, forbiddenDetail, unavailableTitle, unavailableDetail,
}: {
  phase: Phase; endpoint: string; error?: string; status?: number | null; onRetry?: () => void;
  emptyTitle?: string; emptyDetail?: ReactNode;
  forbiddenDetail?: ReactNode;
  unavailableTitle?: string; unavailableDetail?: ReactNode;
}) {
  if (phase === "ok") return null;
  if (phase === "loading") return <BentoState phase="loading" />;
  if (phase === "forbidden") {
    return <BentoState phase="forbidden" title="无权限" detail={forbiddenDetail || ("端点 " + endpoint + " 返回 401/403；本页只读，请联系平台管理员开通查看权限。")} />;
  }
  if (phase === "error") {
    return <BentoState phase="error" title="数据加载失败" detail={"端点 " + endpoint + " · " + (status ? "返回码 " + status : (error || "网络不可达")) + " · " + (onRetry ? "可重试；" : "") + "失败时不显示 0 冒充。"} onRetry={onRetry} />;
  }
  if (phase === "empty") {
    return <BentoState phase="empty" title={emptyTitle || "暂无数据"} detail={emptyDetail} />;
  }
  return <BentoState phase="unavailable" title={unavailableTitle || "数据不可得"} detail={unavailableDetail} />;
}