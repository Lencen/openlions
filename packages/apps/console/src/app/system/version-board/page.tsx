// 版本看板 /system/version-board（2026-11-06，商业化线任务）
// 只读页：数据源 packages/apps/console/src/data/version-board.json
// 维护规则：内容只由 commercialization-line 更新；其他线只改展示层。
// 口径：无条目一律显示"暂无条目（内容由商业化线维护）"，不写 0、不留空。
import board from "@/data/version-board.json";
import { PageHeader, PageTitle, Pill } from "@/components/ui";
import styles from "./page.module.css";

type Item = { type: string; id: string; title: string; owner?: string; state?: string; note?: string };
type Train = { version: string; status?: string; eta?: string | null; items?: Item[] };

const data = board as {
  updatedAt?: string;
  owner?: string;
  note?: string;
  types?: Record<string, string>;
  states?: Record<string, string>;
  trains?: Train[];
};

const trains: Train[] = Array.isArray(data.trains) ? data.trains : [];
const types = data.types || { REQ: "需求", BUG: "缺陷", SEC: "安全", TASK: "任务" };
const states = data.states || { done: "已完成", doing: "进行中", blocked: "阻塞", todo: "待开始" };

export const metadata = { title: "版本看板 · /system/version-board" };

export default function VersionBoardPage() {
  return (
    <main className={styles.wrap}>
      <PageHeader>
        <PageTitle>版本看板</PageTitle>
        <Pill tone="neutral">只读</Pill>
      </PageHeader>

      <p className={styles.meta}>
        更新于 <b>{data.updatedAt || "不可得（无 updatedAt）"}</b> · 维护：
        <b>{data.owner || "commercialization-line"}</b> · 其他线只读
        {data.note ? <> · {data.note}</> : null}
      </p>

      {trains.length === 0 ? (
        <div className={styles.empty}>暂无车次（version-board.json 的 trains 为空）</div>
      ) : (
        <div className={styles.grid}>
          {trains.map((t) => {
            const items = t.items || [];
            const counts = Object.keys(types).map((k) => ({
              k,
              n: items.filter((i) => i.type === k).length,
            }));
            return (
              <section key={t.version} className={styles.card}>
                <header className={styles.cardHead}>
                  <h2 className={styles.ver}>{t.version}</h2>
                  <span className={styles.status}>{t.status || "未开始"}</span>
                </header>
                <div className={styles.eta}>
                  {t.eta ? "预计 " + t.eta : "预计时间：未定"}
                </div>
                <div className={styles.counts}>
                  {counts.map((c) => (
                    <span key={c.k} className={styles.count}>
                      {types[c.k]} {c.n > 0 ? c.n : "0"}
                    </span>
                  ))}
                </div>
                {items.length === 0 ? (
                  <p className={styles.emptyItem}>暂无条目（内容由商业化线维护）</p>
                ) : (
                  <ul className={styles.list}>
                    {items.map((i) => (
                      <li key={i.id} className={styles.item}>
                        <span className={styles.chip}>{types[i.type] || i.type}</span>
                        <span className={styles.id}>{i.id}</span>
                        <span className={styles.title}>{i.title}</span>
                        <span className={styles.state}>{states[String(i.state || "")] || "待开始"}</span>
                        {i.owner ? <span className={styles.owner}>{i.owner}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
