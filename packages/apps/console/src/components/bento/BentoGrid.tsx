"use client";
import type { ReactNode } from "react";
import styles from "./Bento.module.css";

/** 12 栅格（<=1199→6，<=900→2）；span 由卡片声明 s1..s12。 */
export default function BentoGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
