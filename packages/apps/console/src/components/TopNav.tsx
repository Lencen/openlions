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
import styles from "./TopNav.module.css";

export default function TopNav() {
  const pathname = usePathname() || "/";
  const hit = useMemo(() => matchNav(pathname), [pathname]);
  const [todos, setTodos] = useState<{ humanOpen: number; open: number } | null>(null);
  // 2026-11-02（前端团队 B2）：版本号**不再写死**。原先是硬编码 "v0.3.0"（与代码 0.1.0、安装 0.1.1 三个号并存）。
  //   现在读 /api/version（仓库根 VERSION + git 提交 + 进程启动时刻）；读不到显示 "v—"，**绝不冒充一个版本号**。
  const [version, setVersion] = useState<{ platform: string; deployedPlatform?: string | null; deployedSource?: string | null; gitSha: string; gitDirty: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/version", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d) return;
        if (typeof d.platform === "string" && d.platform) {
          setVersion({ platform: d.platform, deployedPlatform: typeof d.deployedPlatform === "string" ? d.deployedPlatform : null, deployedSource: typeof d.deployedSource === "string" ? d.deployedSource : null, gitSha: String(d.gitSha || ""), gitDirty: Boolean(d.gitDirty) });
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
        <span className="logo-text">Lions 控制台</span>
      </div>
      <div className="topnav-context">
        {hit ? (
          <>
            <span className={"ctx-group " + styles.ctxGroup}>{hit.group.label}</span>
            <span className="ctx-sep">/</span>
            <span className="ctx-page">{hit.item.label}</span>
          </>
        ) : (
          <span className="ctx-page">{t('topnav.managementHub')}</span>
        )}
      </div>
      <div className="topnav-right">
        {/* 2026-10-15（round 76-GP）铁律 2 的系统性做法: 全站每一页都显示"本页数据取自 HH:MM:SS" */}
        <GlobalSearch />
        <div className={styles.demoControls} aria-label="视图设置">
          <button type="button" className={styles.demoSelect} title="风格（demo slot；当前固定 Bento）">风格 <b>Bento（默认）</b> ▾</button>
          <button type="button" className={styles.demoSelect} title="四态预览（demo slot；当前正常）">四态 <b>正常</b> ▾</button>
          <span className={styles.avatar} title="当前用户（示意）">LE</span>
        </div>
      </div>
    </nav>
  );
}