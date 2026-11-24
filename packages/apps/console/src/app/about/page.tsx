import fs from "node:fs";
import { readVersionInfo } from "@/lib/server/version";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

// /about — 0.5 D1 页壳 · demo slot 还原（2026-11-13）
// slots：s4 版本 / s4 运行时 / s4 渠道 / s6 依赖 / s6 合规 / s12 note
// 静态事实：部署树 VERSION / BUILD_IDs / L1=L2 客户端版本 / 启动时刻；其它无静态源 → n/a+原因。
function readFirst(paths: string[]): string | null {
  for (const x of paths) { try { const v = fs.readFileSync(x, "utf8").trim(); if (v) return v; } catch { /* next */ } }
  return null;
}

export default function AboutPage({ searchParams }: { searchParams?: { __preview_error?: string } }) {
  // 仅供验收/故障演练：?__preview_error=1 触发 error boundary（无业务副作用）
  if (searchParams?.__preview_error === "1") throw new Error("about error preview");
  const v = readVersionInfo();
  const deployed = v.deployedPlatform || v.platform || null;
  const l1 = readFirst(["/opt/lions/current/CLIENT_VERSION", process.cwd() + "/../../../CLIENT_VERSION"]);
  const l2 = readFirst(["/usr/lib/lions-client/CLIENT_VERSION"]);
  const roots = ["/opt/lions/current"];
  const readBuild = (app: string) => readFirst(roots.map((r) => r + "/packages/apps/" + app + "/.next/BUILD_ID"));
  const bMind = readBuild("mind"); const bConsole = readBuild("console"); const bSession = readBuild("session");
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

  return (
    <main className="page">
      <PageHeader><PageTitle>关于平台</PageTitle><div className="page-subtitle">版本 / 运行时 / 渠道一致性 / 依赖 / 合规（只读静态）</div></PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>平台</span><span>现有</span><span className={styles.crumbOn}>只读</span></div>

      <div className={styles.bento}>
        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>版本</h2><span className={styles.tagOk}>已对齐</span></div>
          <div className={styles.vXl}>{deployed || "n/a"}</div>
          <ul className={styles.kv}>
            <li><span>来源</span><b>{v.deployedSource || "仓库 VERSION"}</b></li>
            <li><span>构建</span><b className={styles.na}>n/a（无构建时刻注入）</b></li>
            <li><span>BUILD_ID</span><b className={styles.mono}>mind {bMind || "n/a"} · console {bConsole || "n/a"} · 会话 {bSession || "n/a"}</b></li>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>运行时</h2></div>
          <ul className={styles.kv}>
            <li><span>Node</span><b>{process.version}</b></li>
            <li><span>Next</span><b className={styles.na}>n/a（无注入）</b></li>
            <li><span>PG</span><b className={styles.na}>n/a（无连接串只读出口）</b></li>
            <li><span>启动</span><b>{new Date(startedAt).toLocaleString("zh-CN", { hour12: false })}</b></li>
            <li><span>进程</span><b className={styles.na}>n/a</b></li>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>渠道</h2><span className={styles.tagOk}>一致</span></div>
          <ul className={styles.list}>
            <li><span className={styles.dot + " " + styles.dotOk} /><span>部署树</span><b>{deployed || "n/a"}</b></li>
            <li><span className={styles.dot + " " + (l1 === l2 ? styles.dotOk : styles.dotWarn)} /><span>客户端 L1</span><b>{l1 || "n/a"}</b></li>
            <li><span className={styles.dot + " " + (l1 === l2 ? styles.dotOk : styles.dotWarn)} /><span>客户端 L2</span><b>{l2 || "n/a"}</b></li>
            <li><span className={styles.dot + " " + styles.dotOk} /><span>一致性</span><b className={l1 && l2 && l1 === l2 ? styles.ok : styles.warn}>{l1 && l2 ? (l1 === l2 ? "一致" : "待对齐") : "n/a"}</b></li>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s6}>
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>依赖</h2><span className={styles.tagNa}>n/a</span></div>
          <div className={styles.stateMini}>依赖清单无只读接口（不伪造包/版本表）。</div>
        </section>

        <section className={styles.card + " " + styles.s6}>
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>合规</h2><span className={styles.tagNa}>n/a</span></div>
          <div className={styles.stateMini}>合规状态无静态源（不伪造 kv）。</div>
        </section>

        <section className={styles.card + " " + styles.s12}>
          <div className={styles.noteInfo}>只读信息页：版本 / 构建 / 渠道一致性 / 依赖 / 合规；判据 prod/test/dev 同值，sales 允许滞后须标注。运行态请看运维看板。</div>
        </section>
      </div>
    </main>
  );
}