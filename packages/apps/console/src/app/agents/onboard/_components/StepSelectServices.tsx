"use client";
import { interactiveProps } from "@/components/a11y";
// agents/onboard 页 · Step 1 选择服务 (从 page.tsx 抽出, 页面瘦身)
// 2026-11-05 P2 呈现层：内联 style 清零（类在 ../page.module.css，ss* 前缀）；
//   选中态的配色由 data-checked + 属性选择器承载，结构与文案未动。
import styles from "../page.module.css";
export default function StepSelectServices({
  services,
  loading,
  selected,
  onToggle,
  onPrev,
  onNext,
}: {
  services: any[];
  loading?: boolean;
  selected: Set<string>;
  onToggle: (name: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const newServices = (services || []).filter((s: any) => s.name?.startsWith("lions_") || s.name === "mcp_agent_chat");
  return (
    <section>
      <h2 className={styles.ssTitle}>
        勾选参与的服务
        <span className={styles.ssCount}>已选 {selected.size} / {newServices.length}</span>
      </h2>
      <div className={styles.ssGrid}>
        {newServices.map((svc: any) => {
          const checked = selected.has(svc.name);
          return (
            <div key={svc.name} {...interactiveProps(selected.has(svc.name))} onClick={() => onToggle(svc.name)}
              className={styles.ssCard} data-checked={checked}>
              <div className={styles.ssCardHead}>
                <span className={styles.ssName}>{svc.display_name || svc.name}</span>
                <span className={styles.ssMark}>{checked ? "✅" : "⬜"}</span>
              </div>
              <div className={styles.ssDesc}>{svc.description}</div>
              <div className={styles.ssPerms}>
                {(svc.available_perms || []).map((p: string) => (
                  <span key={p} className={styles.ssPerm}>{p}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {!loading && newServices.length === 0 && (
        <div className={styles.ssEmpty}>暂无可选业务服务</div>
      )}
      <div className={styles.ssActions}>
        <button onClick={onPrev} className={styles.scBtn}>← 上一步</button>
        <button onClick={onNext} disabled={selected.size === 0} className={styles.ssBtnNext}>
          下一步 →
        </button>
      </div>
    </section>
  );
}
