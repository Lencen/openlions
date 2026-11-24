"use client";
import type { ReactNode } from "react";
import styles from "./Bento.module.css";

export default function BentoCard({ title, sub, span = 4, actions, children, state }: {
  title?: ReactNode; sub?: ReactNode; span?: number; actions?: ReactNode; children?: ReactNode; state?: "ok" | "loading" | "empty" | "error" | "unavailable" | "forbidden";
}) {
  return (
    <section className={styles.card + " " + (styles["s" + span] || styles.s4)} data-state={state || "ok"}>
      {(title || actions) ? (
        <header className={styles.cardHead}>
          <div><h2 className={styles.cardTitle}>{title}</h2>{sub ? <p className={styles.cardSub}>{sub}</p> : null}</div>
          {actions ? <div className={styles.cardActions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}