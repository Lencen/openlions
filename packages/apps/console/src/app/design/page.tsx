"use client";
// 2026-10-25 R6：设计规范总览页（kitchen sink / design gallery）
// 为什么需要：整改前平台没有任何一页能把 token 与组件一次性看全，于是「哪个页面用了 9px、
//   哪个卡片多了一层边框」只能靠人肉翻页；评审 §1 结论里「成熟设计系统都有一页 gallery」。
// 用途：①视觉回归基线（截图对比）②新页面抄样式时的唯一参照 ③设计合规门的人工兜底。
// 2026-11-06 token-ratchet：呈现层改造 —— 内联 style 34 -> 0、棘轮裸值 5 -> 0（下沉同目录 page.module.css）。
//   字号尺度的"示例字号/字重"改走 [data-fs]（值取自 TYPE_SCALE 的令牌名），颜色示例的底色改走
//   [data-swatch]（值就是色令牌名）；示例本身仍按真实令牌渲染，所以这一页仍是唯一的视觉参照。
//   未改取数、接口、路由、文案、字段名与导出 props 形状；页头结构与 globals.css 未动。
import Icon from "@/components/Icon";
import KPICard from "@/components/KPICard";
import DataTable, { StateChip } from "@/components/DataTable";
import DensityToggle from "@/components/DensityToggle";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

const TYPE_SCALE: { token: string; sample: string; hint: string }[] = [
  { token: "--fs-3xl / 30px", sample: "325,918", hint: "主数值（每屏最多一个）" },
  { token: "--fs-2xl / 24px", sample: "平台总览", hint: "页面标题" },
  { token: "--fs-xl / 20px", sample: "业务环 · 渠道构成", hint: "区块标题" },
  { token: "--fs-lg / 16px", sample: "会话接入 · 24 小时", hint: "卡片标题" },
  { token: "--fs-md / 15px", sample: "智能体工作 · 正常", hint: "强调正文" },
  { token: "--fs-base / 14px", sample: "峰时段的提炼队列会堆到 1,500 段以上", hint: "正文（默认）" },
  { token: "--fs-sm / 13px", sample: "待提炼 1,546 · 已提炼 154", hint: "标签 / 说明" },
  { token: "--fs-xs / 12px", sample: "更新于 16:14:28", hint: "微标（下限）" },
];

const COLORS: { name: string; varName: string; use: string }[] = [
  { name: "主色", varName: "--primary", use: "唯一强调色：主要按钮、选中态、焦点" },
  { name: "正常", varName: "--status-ok", use: "状态：健康 / 通过" },
  { name: "留意", varName: "--status-warn", use: "状态：积压 / 降级" },
  { name: "异常", varName: "--status-crit", use: "状态：失败 / 中断" },
  { name: "空闲", varName: "--text-muted", use: "状态：本时段无数据" },
  { name: "表面 1", varName: "--bg-surface", use: "卡片底" },
  { name: "表面 2", varName: "--bg-surface2", use: "次级底 / hover" },
  { name: "表面 3", varName: "--bg-surface3", use: "轨道 / 进度底" },
  { name: "边框", varName: "--border", use: "容器边界（不用于分组）" },
];

const ICONS: string[] = [
  "compass", "dashboard", "calendar", "check-square", "message-square", "radio", "mail", "folder",
  "git-branch", "bot", "activity", "plug", "shield-check", "wrench", "rocket", "refresh",
  "building", "cpu", "package", "book", "message-dots", "target", "sprout", "bar-chart",
  "banknote", "settings", "lightbulb", "search", "trending-up", "clipboard", "file-text", "store",
  "puzzle", "lock", "heart", "cone", "coins", "eye", "key", "users", "server", "inbox",
];

const SAMPLE_ROWS = [
  { id: "a1", name: "agent-d", sub: "custom · 101", state: "ok", stateText: "在线", n: 7 },
  { id: "a2", name: "agent-i", sub: "custom · [host]", state: "warn", stateText: "离线兜底", n: 6 },
  { id: "a3", name: "operator", sub: "human · 101", state: "idle", stateText: "空闲", n: 1 },
];

export default function DesignPage() {
  return (
    <div className="layout"><main className="main">
      <PageHeader>
        <div className={styles.headerRow}>
          <PageTitle>设计规范</PageTitle>
          {/* 2026-10-25：密度是高级偏好，放这里而不是顶栏 —— 顶栏加控件会挤掉通知按钮（实测遮挡点击）。 */}
          <div className={styles.densityBox}>
            <span className="tiny">界面密度</span>
            <DensityToggle />
          </div>
        </div>
        <div className="page-subtitle">
          平台唯一视觉参照：字号、颜色、层级、图标与组件都在这一页。改样式前先看这里，改完回来对照。
          守门：<code>npm run check:ui-design</code>（最小字号 / 字号种类 / chrome emoji / 卡片边框 / 点击目标 / 原始异常）。
        </div>
      </PageHeader>

      <section className="panel">
        <div className="panel-header"><span className="panel-title">字号尺度</span><span className="tiny">正文 14 · 微标 12 为下限，禁止 9/10px</span></div>
        <div className={styles.panelBody}>
          {TYPE_SCALE.map((t) => (
            <div key={t.token} className={styles.typeRow}>
              <code className={styles.typeToken}>{t.token}</code>
              <span className={styles.typeSample} data-fs={t.token.split(" ")[0].replace("--fs-", "")}>{t.sample}</span>
              <span className={"tiny " + styles.typeHint}>{t.hint}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><span className="panel-title">颜色</span><span className="tiny">一个主色 + 四个状态色；颜色只表达状态与层级，不做装饰</span></div>
        <div className={styles.swatchGrid}>
          {COLORS.map((c) => (
            <div key={c.varName} className={styles.swatchCard}>
              <span className={styles.swatchChip} data-swatch={c.varName} />
              <span>
                <span className={styles.swatchName}>{c.name} <code className={styles.swatchVar}>{c.varName}</code></span>
                <span className="tiny">{c.use}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><span className="panel-title">图标</span><span className="tiny">24×24 线性、currentColor、1.7 描边；emoji 只允许出现在用户内容里</span></div>
        <div className={styles.iconGrid}>
          {ICONS.map((n) => (
            <div key={n} className={styles.iconCell}>
              <Icon name={n} size={18} />
              <code className={styles.iconName}>{n}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><span className="panel-title">指标卡 · 两种</span><span className="tiny">解剖固定：标签 12 → 数值 26–30 + 单位 → 说明 12</span></div>
        <div className={styles.kpiStack}>
          <div className="kpi-grid">
            <KPICard label="进入会话" value="284" delta="▲ 12% 较前一日" deltaDir="up" hint="待提炼 1,546 段" />
            <KPICard label="沉淀资产" value="331" delta="▲ 4% 较前一日" deltaDir="up" hint="平均质量 0.63" />
          </div>
          <div className="metric-row">
            <KPICard label="未完成待办" size="hero" tone="info" value="82" unit="条" hint="全部未完成 · 当前视图 12 条" />
            <KPICard label="需要人决策" tone="warn" value="13" unit="条" hint="人类负责的未完成项" />
            <KPICard label="逾期" tone="ok" value="0" unit="条" hint="没有逾期待办" />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><span className="panel-title">表格与状态片</span><span className="tiny">数值右对齐等宽；状态用色点 + 文字，不只靠颜色</span></div>
        <DataTable
          rows={SAMPLE_ROWS}
          rowKey={(r: any) => r.id}
          columns={[
            { key: "who", title: "智能体", render: (r: any) => (<div className="dt-cell-who"><span className="dt-avatar">{r.name.slice(0, 2)}</span><span><span className="dt-who-name">{r.name}</span><span className="dt-who-sub">{r.sub}</span></span></div>) },
            { key: "state", title: "状态", width: "140px", render: (r: any) => <StateChip state={r.state} text={r.stateText} /> },
            { key: "n", title: "权限", align: "right", width: "90px" },
          ]}
        />
      </section>

      <section className="panel">
        <div className="panel-header"><span className="panel-title">空 / 加载 / 错误</span><span className="tiny">三种态都要设计；错误说人话，技术细节折叠</span></div>
        <div className={styles.stateGrid}>
          <div className={styles.stateCard}>
            <Icon name="inbox" size={20} />
            <div className={styles.stateTitle}>还没有数据</div>
            <div className={"tiny " + styles.stateNote}>换个时间范围，或等下一轮同步。</div>
          </div>
          <div className={styles.stateCard}>
            <div className={"dt-skel " + styles.skelWide} />
            <div className={"dt-skel " + styles.skelRow} />
            <div className={"dt-skel " + styles.skelNarrow} />
          </div>
          <div className={styles.stateCard}>
            <Icon name="alert" size={20} />
            <div className={styles.stateTitle}>数据暂时取不到</div>
            <div className={"tiny " + styles.stateNote}>页面其余部分可用，可重试。</div>
            <details className={"tech-detail " + styles.techDetails}><summary>技术详情</summary><code>upstream timeout (code=ETIMEDOUT)</code></details>
          </div>
        </div>
      </section>
    </main></div>
  );
}
