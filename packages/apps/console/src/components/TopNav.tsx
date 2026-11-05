"use client";
// 2026-09-10 商业化改版: 顶部品牌栏 (导航已统一到左侧分组导航, 此处只做品牌 + 当前页上下文 + 状态)
// 2026-09-10 追加: 顶部"待办"快捷入口 (显示需要人决策的未完成待办数)
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import { usePathname } from "next/navigation";
import Link from "next/link";
// 2026-09-18 Phase2 antd 绞杀: Tooltip 改用自研原子件(components/primitives, 同 API 形状)
import { Tooltip } from "@/components/primitives";
import { t } from "@/i18n";
import { matchNav } from "@/config/nav";
import { fmtNum } from "@/lib/format";
import GlobalSearch from "@/components/GlobalSearch";
import TopNavNotifications from "@/components/TopNavNotifications";
import DataMomentBadge from "@/components/DataMomentBadge";
import styles from "./TopNav.module.css";

export default function TopNav() {
  const pathname = usePathname() || "/";
  const hit = useMemo(() => matchNav(pathname), [pathname]);
  const [todos, setTodos] = useState<{ humanOpen: number; open: number } | null>(null);
  // 2026-11-02（前端线 B2）：版本号**不再写死**。原先是硬编码 "v0.3.0"（与代码 0.1.0、安装 0.1.1 三个号并存）。
  //   现在读 /api/version（仓库根 VERSION + git 提交 + 进程启动时刻）；读不到显示 "v—"，**绝不冒充一个版本号**。
  const [version, setVersion] = useState<{ platform: string; gitSha: string; gitDirty: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/version", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d) return;
        if (typeof d.platform === "string" && d.platform) {
          setVersion({ platform: d.platform, gitSha: String(d.gitSha || ""), gitDirty: Boolean(d.gitDirty) });
        }
      })
      .catch(() => { /* 版本不可达 -> 保持 v—，不显示假版本 */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      // 2026-10-15（round 76-GI）**两处修复**, 都在这一行:
      //   ① **慢**: 这里原来拉 500 条待办, 只为算一个数字 —— 实测该请求要 **9.2 秒**,
      //      而它是**外壳级**的(每页都跑) -> 拖慢全站每一次页面加载 ✗。
      //   ② **可能算错**: 它用 rows.filter(...).length 自己数"未完成" ✗ ——
      //      一旦待办超过 500 条, 角标就会**少算** ✗。
      //   修法: 上游**本来就返回按状态的计数** (counts: [{status, c}]) ✓,
      //         直接用它算即可 -> **一条行都不需要**, 于是把 limit 收到 1 ✓。
      fetch("/api/todos?status=ALL&limit=1", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!alive || !d) return;
          const cs = Array.isArray(d?.counts) ? d.counts : [];
          const open = cs
            .filter((c: any) => ["OPEN", "DOING", "BLOCKED"].includes(String(c?.status)))
            .reduce((a: number, b: any) => a + Number(b?.c || 0), 0);
          setTodos({ humanOpen: Number(d?.humanOpen || 0), open });
        })
        .catch(() => { /* 待办数不可用不影响导航 */ });
    };
    load();
    const t = setInterval(load, 60000); // 1 分钟一次, 轻量
    return () => { alive = false; clearInterval(t); };
  }, [pathname]);

  return (
    <nav className="topnav" aria-label="主导航">
      <div className="topnav-logo">
        <div className="logo-icon" aria-hidden="true" />
        <span className="logo-text">LIONS Console</span>
      </div>
      <div className="topnav-context">
        {hit ? (
          <>
            <span className={"ctx-group " + styles.ctxGroup}>{hit.group.label}</span>
            <span className="ctx-sep">/</span>
            <span className="ctx-page">{hit.item.label}</span>
            {hit.item.desc ? <span className="ctx-desc">{hit.item.desc}</span> : null}
          </>
        ) : (
          <span className="ctx-page">{t('topnav.managementHub')}</span>
        )}
      </div>
      <div className="topnav-right">
        {/* 2026-10-15（round 76-GP）铁律 2 的系统性做法: 全站每一页都显示"本页数据取自 HH:MM:SS" */}
        <DataMomentBadge />
        <GlobalSearch />
        {/* 2026-10-22 通知聚合：本线未确认 / 传输待处理 / 未送达（真实数据，不可达时不显示 0） */}
        <TopNavNotifications />
        <Tooltip title={t('topnav.todoTip')}>
          {/* 2026-09-24: 徽标深链带 owner=human —— 有待我处理时直达已筛选态 (IA 整改: 过滤视图不另占菜单位) */}
          <Link href={todos && todos.humanOpen > 0 ? "/todo?owner=human" : "/todo"} className="topnav-todo" aria-label={t('nav.item.todo.label')}>
            <Icon name="check-square" size={16} />
            <span>{t('topnav.todoShort')}</span>
            {todos ? (
              <span className={"todo-badge" + (todos.humanOpen > 0 ? " hot" : "")}>
                {todos.humanOpen > 0 ? fmtNum(todos.humanOpen) : fmtNum(todos.open)}
              </span>
            ) : null}
          </Link>
        </Tooltip>
        {/* 2026-10-22 a11y：aria-label 不能挂在没有 role 的 span 上（axe: aria-prohibited-attr），补 role="img" */}
        <span className={"pulse-dot " + styles.pulseOk} role="img" title="服务在线" aria-label="服务在线" />
        <span
          className={styles.version}
          title={
            version
              ? `版本号 ${version.platform}${version.gitSha ? ` · ${version.gitSha}` : ""}${version.gitDirty ? " · 工作区有未提交改动" : ""}（来自仓库根 VERSION，/api/version）`
              : "版本号读取中或不可达（不显示假版本）"
          }
          data-version-source="/api/version"
        >{version ? `v${version.platform}` : "v—"}</span>
      </div>
    </nav>
  );
}
