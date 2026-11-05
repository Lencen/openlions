"use client";
// 守门详情抽屉 — 守门规则管理页面 (#3) 用
// 2026-09-24: 与 CognitiveDetailDrawer 同模式 (侧边抽屉, 不离开列表)。
// 展示 4 段:①基础信息(层/触发/源码位置) ②复算命令(可复制) ③最近一次跑的结果(从 service-check 拉)
//           ④关联事件/告警(FlywheelEvent) ⑤出处 PR(git log)
//
// 只读 — 不引入可写配置; 与 SSOT(guard-registry.json = 源码投影)保持单向。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 事件手写 .tbl 表 → 白名单 DataTable。
//   列/字段/文案不变；PASS/FAIL 配色改走 data-tone 属性选择器。取数（/api/guards/[id]）未改。
import { useLazyApi } from "@/lib/api";
import { Drawer } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./GuardDetailDrawer.module.css";

interface GuardDetailResp {
  guard: { id: string; layer: string; name: string; file: string; line: number; trigger: string; action: string; note: string; recompute: string };
  layer: { id: string; name: string; desc: string; trigger: string; count: number } | null;
  registry: { generatedAt: string; fingerprint: string };
  lastRun: { ok: boolean; detail: string; serviceCheckAt: string } | null;
  events: Array<{ id: string; type: string; source: string; message: string; createdAt: number; createdAtText: string }>;
  provenance: Array<{ hash: string; subject: string; author: string; date: string }>;
}

type EventRow = GuardDetailResp["events"][number];

const eventColumns: DataColumn<EventRow>[] = [
  { key: "createdAtText", title: "时间", width: 130, render: (e) => <span className="nowrap mono">{e.createdAtText}</span> },
  { key: "type", title: "类型", width: 80, render: (e) => <span className="nowrap">{e.type}</span> },
  { key: "message", title: "消息", render: (e) => <span className={styles.rowValue}>{e.message}</span> },
];

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>{label}</div>
      <div className={(mono ? "mono " : "") + styles.rowValue}>{value}</div>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  return (
    <button type="button" className={"badge " + styles.copyBtn}
      onClick={() => { try { navigator.clipboard.writeText(text); } catch {} }}
      title="复制">📋</button>
  );
}

export default function GuardDetailDrawer({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const path = id ? `/api/guards/${encodeURIComponent(id)}` : null;
  const { data, loading, error } = useLazyApi<GuardDetailResp>(path);

  return (
    <Drawer open={open} onClose={onClose} width={580} title={data?.guard ? `守门详情 · ${data.guard.name}` : "守门详情"}>
      {loading && <div className={styles.stateMsg} data-tone="dim">加载中…</div>}

      {!loading && error && (
        <div className={styles.stateMsg} data-tone="crit">守门详情加载失败: {String((error as Error)?.message || error)}</div>
      )}

      {!loading && !error && !data && (
        <div className={styles.stateMsg} data-tone="crit">守门 `{id}` 不存在或详情不可读</div>
      )}

      {!loading && data && (<>
        {/* 1. 基础信息 */}
        <div className={styles.sectionTitle + " " + styles.sectionFirst}>① 基础信息</div>
        <Row label="守门编号" value={data.guard.id} mono />
        <Row label="层" value={`${data.guard.layer} · ${data.layer?.name ?? "?"}`} />
        <Row label="名称" value={data.guard.name} />
        <Row label="触发" value={data.guard.trigger} />
        {data.guard.note && <Row label="说明" value={data.guard.note} />}

        {/* 2. 复算命令(可复制) */}
        <div className={styles.sectionTitle + " " + styles.section}>② 复算命令</div>
        <div className={styles.codeBox}>
          <div className={styles.codeText}>{data.guard.recompute || `(暂无复算命令; 源码位置 ${data.guard.file}:${data.guard.line})`}</div>
          <div className={styles.copyWrap}>
            <CopyBtn text={data.guard.recompute || `${data.guard.file}:${data.guard.line}`} />
          </div>
        </div>

        {/* 3. 最近一次跑的结果 */}
        <div className={styles.sectionTitle + " " + styles.section}>③ 最近一次跑的结果</div>
        {data.lastRun ? (
          <div className={styles.lastRun} data-tone={data.lastRun.ok ? "ok" : "crit"}>
            <div className={styles.lastRunHead}>
              <span className={"badge " + styles.passBadge} data-tone={data.lastRun.ok ? "ok" : "crit"}>
                {data.lastRun.ok ? "✓ PASS" : "✗ FAIL"}
              </span>
              <span className={styles.metaSm}>{data.lastRun.serviceCheckAt.replace("T", " ").slice(0, 19)}</span>
            </div>
            <div className={styles.detailText}>{data.lastRun.detail}</div>
          </div>
        ) : (
          <div className={styles.mutedBox}>
            此守门未被 service-check-5h 直接覆盖(名字未出现在 checks[] 中)。
            <br />它可能是:①提交前 (L1 pre-commit) ②验收判据 (L3 spec 在 acceptance runner 中跑) ③运行期门禁 (L4 内联调用) ④单点文档 (L5 人工阅读)。
            <br />复算请按 ② 段的命令手动跑。
          </div>
        )}

        {/* 4. 关联事件 / 告警 */}
        <div className={styles.sectionTitle + " " + styles.section}>④ 关联事件 / 告警 (平台事件流, 最近 5 条)</div>
        {data.events.length === 0 ? (
          <div className={styles.plainMuted}>暂无事件</div>
        ) : (
          <>
          <TableCopyButton />
          <div className={styles.eventsWrap}>
            <DataTable columns={eventColumns} rows={data.events} rowKey={(e) => e.id} />
          </div>
          </>
        )}

        {/* 5. 出处 PR */}
        <div className={styles.sectionTitle + " " + styles.section}>⑤ 出处 (最近 5 个改动该源码文件的 commit)</div>
        <div className={styles.fileLine}>文件: <span className="mono">{data.guard.file}:{data.guard.line}</span></div>
        {data.provenance.length === 0 ? (
          <div className={styles.plainMuted}>git 不可达或文件无变更历史</div>
        ) : (
          <div>
            {data.provenance.map((p) => (
              <div key={p.hash} className={styles.provRow}>
                <span className={"mono " + styles.provHash}>{p.hash}</span>
                <span className={styles.provMeta}>{p.date} · {p.author}</span>
                <div className={styles.provSubject}>{p.subject}</div>
              </div>
            ))}
          </div>
        )}

        {/* footer 信息 */}
        <div className={styles.footer}>
          总表生成于 {data.registry.generatedAt.replace("T", " ").slice(0, 19)} · fingerprint <span className="mono">{data.registry.fingerprint.slice(0, 12)}…</span>
          <br />防漂移: <span className="mono">node scripts/guard-registry.cjs --check</span>
        </div>
      </>)}
    </Drawer>
  );
}
