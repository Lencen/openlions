"use client";
import Link from "next/link";
import Icon from "@/components/Icon";
import { usePathname } from "next/navigation";
import { getSubmodules, Submodule } from "@/config/submodules";
import { t } from "@/i18n";
import styles from "./SubSidebar.module.css";

interface Props {
  module: string;
  moduleName: string;
}

export default function SubSidebar({ module, moduleName }: Props) {
  const pathname = usePathname();
  const subs = getSubmodules(module);

  return (
    <aside className="sidebar" aria-label={`${moduleName} 子模块导航`}>
      <div className="sidebar-group">
        <div className="sidebar-group-label">{moduleName}</div>
        {subs.map((s: Submodule) => {
          const active = pathname === s.href;
          return (
            <Link
              key={s.id}
              href={s.href}
              className={`sidebar-item ${active ? "active" : ""}`}
              title={s.desc}
              aria-label={s.label}
            >
              <span className="icon" aria-hidden="true"><Icon name={s.icon} size={16} /></span>
              <span>{s.label}</span>
              {s.isNew && <span className={"badge new " + styles.badgeNew}>{t('common.new')}</span>}
              {s.locked && <span className={styles.locked} aria-label="未实现"><Icon name="lock" size={14} /></span>}
            </Link>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <div className="row">
          <span className={"dot " + styles.dotOk} />
          <span>数据实时</span>
          <span className="num">{t('common.live')}</span>
        </div>
        <div className="row">
          <span className={"dot " + styles.dotCore} />
          <span>模块</span>
          <span className="num">{module}</span>
        </div>
      </div>
    </aside>
  );
}
