"use client";
// 2026-09-10 商业化改版: 统一左侧导航 (分组: 概览 / 飞轮 / Agent / 数据 / 平台)
// 所有既有路由均登记在 config/nav.ts, 保证不丢页面。
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
// 2026-09-18 Phase2 antd 绞杀: Menu/Tag 改用自研原子件(components/primitives, 同 API 形状)
import { Menu, Tag } from "@/components/primitives";
import { NAV_GROUPS, matchNav, defaultOpenGroups } from "@/config/nav";
import Icon from "@/components/Icon";
import Link from "next/link";
// 2026-11-05 P2 批8：内联 style 清零（样式下沉 ./GlobalSidebar.module.css）；取数/路由/导航结构未动。
import styles from "./GlobalSidebar.module.css";

// 2026-10-19 B1(信息架构方案 L1-1): 导航项**锚点化**。
//   原先侧栏是 Menu + onClick/ router.push 跳转, 实测**每页侧栏 0 个 <a href>**
//   (5 页基线: /system/health 全页 1 个、/ 5 个、/todo 22 个 —— 全都是正文链接, 侧栏贡献 0)。
//   后果: 管理员不能 ⌘/右键新开标签做多页对照, 也不能把某个页面的 URL 复制给同事。
//   这里把**可跳转**项渲染成真实 <Link>(保留原 class/样式/高亮), 不可跳转项(纯分组/锁定/子菜单父项)仍是 <span>。
const DEMO_BADGE: Record<string, string> = { "/market": "M", "/system/health": "M", "/todo": "M", "/agents/groups": "NEW", "/terminals": "M", "/design": "M", "/tools": "NEW", "/tools/mcp": "NEW", "/lineage": "M" };

function NavLabel({ icon, label, desc, badge, locked, href }: {
  icon: string; label: string; desc?: string; badge?: string; locked?: boolean; href?: string;
}) {
  const pathname = usePathname() || "/";
  const currentHref = matchNav(pathname)?.item?.href;
  const active = !!href && (pathname === href || currentHref === href || (href !== "/" && pathname.startsWith(href + "/")));
  const inner = (
    <>
      <span className="nav-item-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>
      <span className="nav-item-text">{label}</span>
      {badge ? <Tag className="nav-item-tag" variant="filled">{badge === "new" ? "新" : badge}</Tag> : null}
      {locked ? <span className={styles.lockedIcon} aria-label="规划中"><Icon name="lock" size={14} /></span> : null}
    </>
  );
  if (!href) return <span className="nav-item-label" title={desc}>{inner}</span>;
  return <Link href={href} className="nav-item-label" title={desc} aria-current={active ? "page" : undefined} data-active={active ? "true" : undefined}>{inner}</Link>;
}

export default function GlobalSidebar() {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const hit = useMemo(() => matchNav(pathname), [pathname]);
  // 未登记路由按业务域归组（0.6 shell B 方案：只高亮分组标题，不改 IA）
  const fallbackGroupId = pathname.startsWith("/system/") || pathname.startsWith("/audit/") ? "board"
    : pathname.startsWith("/cognitive/") ? "data"
    : pathname.startsWith("/agents/") ? "member"
    : pathname.startsWith("/flywheel/") ? "flywheel"
    : pathname.startsWith("/tools/") || pathname.startsWith("/terminals") ? "toolbox"
    : pathname.startsWith("/sessions") || pathname.startsWith("/messages") || pathname.startsWith("/docs") ? "service"
    : pathname.startsWith("/platform") ? "platform" : "";
  const activeGroupId = hit?.group.id || fallbackGroupId;
  const [openKeys, setOpenKeys] = useState<string[]>(() => defaultOpenGroups(pathname));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerBtnRef = useRef<HTMLButtonElement>(null);
  // 2026-11-02（前端团队 B2）：侧栏底部版本号同样不再写死，读 /api/version；读不到显示 "v—"。
  const [version, setVersion] = useState<{ platform: string; deployedPlatform?: string | null; deployedSource?: string | null; gitSha: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/version", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d) return;
        if (typeof d.platform === "string" && d.platform) setVersion({ platform: d.platform, deployedPlatform: typeof d.deployedPlatform === "string" ? d.deployedPlatform : null, deployedSource: typeof d.deployedSource === "string" ? d.deployedSource : null, gitSha: String(d.gitSha || "") });
      })
      .catch(() => { /* 不可达 -> v— */ });
    return () => { alive = false; };
  }, []);
  // 2026-09-24 注: 这里**不再**放待我处理徽标。
  //   实测发现顶栏 TopNav.tsx 已有同语义徽标(`/api/todos` 的 humanOpen, 高亮+跳 /todo),
  //   与本处 /api/pending-for-me 计数重复 —— 同一件事两个数字会让人困惑, 故只保留右上角那一个
  //   (也是 operator 明确要求的"右上角放个审批入口")。


  // 路由变化时确保所属分组展开
  useEffect(() => {
    const shouldOpen = defaultOpenGroups(pathname);
    setOpenKeys((prev) => Array.from(new Set([...prev, ...shouldOpen])));
  }, [pathname]);

  // <1024 抽屉：Esc 关闭 + 焦点回到触发按钮
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setDrawerOpen(false); drawerBtnRef.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
  useEffect(() => { setDrawerOpen(false); }, [pathname]);

  // 2026-09-21 IA 重构(前置-1): 渲染二级菜单(children=submenu) + 预留禁用项(locked)
  //   —— 顶级只放模块, 详情从列表进; 子项 href 缺省(纯分组/预留)时禁用, 不触发跳转。
  const items = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        key: g.id,
        // 2026-10-26（老板反馈「三级层级看不出来」）：一级不再用圆点，改为**颜色区块 + 层级缩进**。
        //   层级靠三件事表达：①一级有整行底色块 ②二级缩进一档 ③三级再缩进并带竖向导引线。
        label: <span className="nav-group-label" data-active={activeGroupId === g.id ? "true" : undefined} aria-current={activeGroupId === g.id && !hit ? "true" : undefined} title={g.label}>{g.label}</span>,
        children: g.items.map((it) => ({
          key: (it.children && it.children.length) ? it.id : (it.href || it.id),
          disabled: !!it.locked || (!it.href && !(it.children && it.children.length)),
          label: (
            <NavLabel
              icon={it.icon}
              label={it.label}
              desc={it.desc}
              badge={it.badge || DEMO_BADGE[it.href || ""]}
              locked={it.locked}
              // 0.6.1 U-39：二级菜单已移除，所有一级项（含原父项 agents/flywheel/config）都可点
              href={it.href}
            />
          ),
          title: it.desc,
          // 0.6.1 U-39（设计 2026-11-17 18:19 确认稿 §3）：**不做二级菜单**——
          //   13 个二级入口下沉到父页「功能入口」带，侧栏只保留 27 个一级项。
          //   nav.ts 里的 children 数据保留（供父页渲染入口带），只是这里不再传给 Menu。
          children: undefined,
        })),
      })),
    []
  );

  return (
    <>
      <button ref={drawerBtnRef} type="button" className={styles.drawerBtn} aria-label="打开导航" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((v) => !v)}>导航</button>
      {drawerOpen ? <div className={styles.scrim} aria-hidden="true" onClick={() => { setDrawerOpen(false); drawerBtnRef.current?.focus(); }} /> : null}
      <aside className={"sidebar sidebar-nav " + styles.asideFixed} data-open={drawerOpen ? "true" : "false"}>
      <Menu
        mode="inline"
        items={items as any}
        selectedKeys={hit ? [hit.item.href] : []}
        openKeys={openKeys}
        onOpenChange={(keys) => setOpenKeys(keys as string[])}
        // 2026-10-19 B1: 可跳转项已由 NavLabel 里的 <Link> 自己导航; 这里仅在"点的不是锚点"时兜底,
        //   避免一次点击既走 Link 又走 router.push 造成两次跳转。
        onClick={(info: any) => {
          const key = info?.key;
          if (typeof key !== "string" || !key.startsWith("/")) return;
          const t = info?.domEvent?.target as HTMLElement | undefined;
          if (t && typeof t.closest === "function" && t.closest("a")) return;
          router.push(key);
        }}
        className={styles.menuPlain}
      />
      <div className="sidebar-footer">
        <div className="row">
          <span className={"dot " + styles.footerDot} data-tone="ok" />
          <span>平台服务</span>
          <span className="num" title={version ? `平台版本 ${version.deployedPlatform || version.platform}（来源 ${version.deployedSource || "/api/version"}）${version.gitSha ? ` · ${version.gitSha}` : ""}` : "版本号读取中或不可达"} data-version-source="/api/version">{version ? `v${version.deployedPlatform || version.platform}` : "v—"}</span>
        </div>
        <div className="row">
          <span className={"dot " + styles.footerDot} data-tone="primary" />
          <span>LIONS Console</span>
        </div>
      </div>
      </aside>
    </>
  );
}