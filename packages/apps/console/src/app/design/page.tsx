"use client";

// /design — 0.5 批次C · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → s6 字号尺度 → s6 颜色 → s6 圆角与间距 → s6 组件样例 → s12 说明。
// 纯静态页（数据卡 card-design 判据 A：不得有 fetch / 轮询）：值来自代码常量与 globals.css 定义，
//   全部标注「示例」，禁止当成平台业务指标；loading / empty / forbidden 不适用，error 与 unavailable 同义用「不可得」。
// 只读：无写操作；密度开关只写本机偏好（localStorage），不是平台配置。

import { ICON_COUNT } from "@/components/Icon";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

const TYPE_SCALE: { token: string; px: string; sample: string; hint: string }[] = [
  { token: "--fs-3xl", px: "30px", sample: "325,918", hint: "主数值（每屏最多一个）" },
  { token: "--fs-2xl", px: "24px", sample: "平台总览", hint: "页面标题" },
  { token: "--fs-xl", px: "20px", sample: "业务环 · 渠道构成", hint: "区块标题" },
  { token: "--fs-lg", px: "16px", sample: "会话接入 · 24 小时", hint: "卡片标题" },
  { token: "--fs-md", px: "15px", sample: "智能体工作 · 正常", hint: "强调正文" },
  { token: "--fs-base", px: "14px", sample: "峰时段的提炼队列会堆到 1,500 段以上", hint: "正文（默认）" },
  { token: "--fs-sm", px: "13px", sample: "待提炼 1,546 · 已提炼 154", hint: "标签 / 说明" },
  { token: "--fs-xs", px: "12px", sample: "更新于 16:14:28", hint: "微标（下限）" },
];

const COLORS: { name: string; varName: string; use: string }[] = [
  { name: "主色", varName: "--primary", use: "唯一强调色：主要按钮、选中态、焦点" },
  { name: "正常", varName: "--status-ok", use: "状态：健康 / 通过" },
  { name: "留意", varName: "--status-warn", use: "状态：积压 / 降级" },
  { name: "异常", varName: "--status-crit", use: "状态：失败 / 中断" },
  { name: "信息", varName: "--info", use: "状态：提示 / 参考" },
  { name: "表面 1", varName: "--bg-surface", use: "卡片底" },
  { name: "表面 2", varName: "--bg-surface2", use: "次级底 / hover" },
  { name: "表面 3", varName: "--bg-surface3", use: "轨道 / 进度底" },
  { name: "边框", varName: "--border", use: "容器边界（不用于分组）" },
];

const RADII: { token: string; px: string; cls: string }[] = [
  { token: "--radius-xs", px: "4px", cls: "radiusXs" },
  { token: "--radius-sm", px: "6px", cls: "radiusSm" },
  { token: "--radius-md", px: "10px", cls: "radiusMd" },
  { token: "--radius-lg", px: "14px", cls: "radiusLg" },
  { token: "--radius-xl", px: "18px", cls: "radiusXl" },
];

export default function DesignPage() {
  return (
    <main className="page">
      <PageHeader>
        <div className={styles.headerRow}>
          <PageTitle>设计规范</PageTitle>
        </div>
        <div className="page-subtitle">
          平台唯一视觉参照：字号、颜色、圆角与间距、组件样例。改样式前先看这里，改完回来对照。
        </div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>工具箱</span>
        <span>看板</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.grid} data-slot="design-sections">
        <section className={styles.card + " " + styles.s6}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>字号尺度</h2>
              <p className={styles.sub}>8 档令牌 · 正文 14、微标 12 为下限 · <span className={styles.demoTag}>示例</span></p>
            </div>
          </div>
          <div className={styles.typeList}>
            {TYPE_SCALE.map((t) => (
              <div key={t.token} className={styles.typeRow}>
                <code className={styles.typeToken}>{t.token} / {t.px}</code>
                <span className={styles.typeSample} data-fs={t.token.replace("--fs-", "")}>{t.sample}</span>
                <span className={styles.typeHint}>{t.hint}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.card + " " + styles.s6}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>颜色</h2>
              <p className={styles.sub}>一个主色 + 状态色 + 三层表面 · <span className={styles.demoTag}>示例</span></p>
            </div>
          </div>
          <div className={styles.swatchGrid}>
            {COLORS.map((c) => (
              <div key={c.varName} className={styles.swatchCard}>
                <span className={styles.swatchChip} data-swatch={c.varName} />
                <span className={styles.swatchMeta}>
                  <span className={styles.swatchName}>{c.name} <code className={styles.swatchVar}>{c.varName}</code></span>
                  <span className={styles.swatchUse}>{c.use}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.card + " " + styles.s6}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>圆角与间距</h2>
              <p className={styles.sub}>5 档圆角 + 4px 基准间距 · <span className={styles.demoTag}>示例</span></p>
            </div>
          </div>
          <div className={styles.radiusList}>
            {RADII.map((r) => (
              <div key={r.token} className={styles.radiusRow}>
                <code className={styles.radiusToken}>{r.token}</code>
                <span className={styles.radiusBar + " " + styles[r.cls]} />
                <span className={styles.radiusPx}>{r.px}</span>
              </div>
            ))}
          </div>
          <p className={styles.noteText}>
            间距以 4px 为基准：语义间距 --gap-sect 20 / --gap-block 16 / --gap-tight 12；微档 --sp-0-5 2 / --sp-1 4 / --sp-2 8 / --sp-3 12。
          </p>
        </section>

        <section className={styles.card + " " + styles.s6}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>组件样例</h2>
              <p className={styles.sub}>按钮 / 标签 / 进度条 / 状态片 · <span className={styles.demoTag}>示例</span></p>
            </div>
          </div>
          <div className={styles.btnRow}>
            <button type="button" className={styles.btnPrimary}>主按钮</button>
            <button type="button" className={styles.btn}>次按钮</button>
            <button type="button" className={styles.btnGhost}>文字按钮</button>
          </div>
          <div className={styles.tagRow}>
            <span className={styles.tagOk}>正常</span>
            <span className={styles.tagWarn}>留意</span>
            <span className={styles.tagCrit}>异常</span>
            <span className={styles.tagInfo}>信息</span>
            <span className={styles.tagIdle}>空闲</span>
          </div>
          <div className={styles.meterRow}>
            <span className={styles.meter}><i className={styles.meterOk + " " + styles.meter92} /></span>
            <span className={styles.meter}><i className={styles.meterWarn + " " + styles.meter64} /></span>
            <span className={styles.meter}><i className={styles.meterCrit + " " + styles.meter28} /></span>
          </div>
          <p className={styles.noteText}>三态样式（空 / 加载 / 错误）在各业务页统一呈现；本页只列视觉单元，不承载运行态数据。</p>
        </section>

        <section className={styles.card + " " + styles.s12}>
          <div className={styles.cardHead}>
            <div>
              
              <p className={styles.sub}>令牌唯一源 · 静态事实 · 四态说明</p>
            </div>
          </div>
          <p className={styles.noteText}>
            令牌唯一源：<code className={styles.code}>packages/ui/ui/src/tokens.css</code>（由 <code className={styles.code}>globals.css</code> 的令牌块引入）。
            本页只读引用同一组变量，不改值；新增视觉需求先改令牌，再改页面。
            本页是纯静态页：字号 8 档、颜色 9 条、圆角 5 档、图标 {ICON_COUNT} 个（代码常量与令牌定义，随构建更新），
            所有示例值都标了「示例」，不能当平台业务指标；页脚不开「当前时刻」类数据时刻。
            四态：loading / empty / forbidden 不适用（无取数、无权限点）；error 与 unavailable 同义，统一用「不可得」——令牌或来源缺失时该格显示 n/a + 原因，不写 0、不用示例值顶替。
          </p>
        </section>
      </div>
    </main>
  );
}