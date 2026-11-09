"use client";
// lineage 页 · 血缘追溯抽屉 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批6：内联 style 清零（样式下沉 LineageDetailDrawer.module.css）；
//   质量分/产物类型配色走 data-tone / data-table 属性选择器，抽屉 body 内边距改由 CSS 接管。
//   两张表仍是 primitives.Table（同一行渲染，列/字段/展开语义未动）。
import { Descriptions, Drawer, Table, Tag, Timeline } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { Pill, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum, fmtScore, fmtTime, qualityTone, relTime, shortId, truncate } from "@/lib/format";
import { TABLE_LABEL, VERIFY_TAG } from "./lineageShared";
import styles from "./LineageDetailDrawer.module.css";

export default function LineageDetailDrawer({
  sel,
  detail,
  detailLoading,
  detailError,
  onClose,
}: {
  sel: { type: string; id: string } | null;
  detail: any;
  detailLoading: boolean;
  detailError?: Error;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={!!sel}
      onClose={onClose}
      size={760}
      className={styles.drawer}
      title={detail?.found ? `血缘追溯 · ${TABLE_LABEL[detail?.type] || detail?.type}` : "血缘追溯"}
      destroyOnHidden
    >
      {detailError ? (
        <div className={styles.errorText}>血缘详情加载失败: {String((detailError as Error)?.message || detailError)}</div>
      ) : !detail?.found ? (
        <StateBlock loading={detailLoading} title="正在读取血缘信息…" rows={4} />
      ) : (
        <div className={styles.stack}>
          <div>
            <div className={styles.detailTitle}>{detail.title}</div>
            <div className="tiny mono">{detail.type} · {detail.id}</div>
          </div>

          <Descriptions
            size="small"
            column={2}
            bordered
            title="来源回溯"
            items={[
              { key: "st", label: "来源类型", children: detail.source?.sourceType || "未标注" },
              { key: "si", label: "来源编号", children: <span className="mono">{detail.source?.sourceId || "-"}</span> },
              { key: "as", label: t('lineage.detail.source'), children: detail.source?.agentSource || "-" },
              {
                key: "ar",
                label: "回溯对象",
                children: detail.source?.resolved ? (
                  <span>
                    <Pill tone="info">{detail.source.resolved.kind}</Pill> {detail.source.resolved.label}
                  </span>
                ) : (
                  <span className="tiny">无法回溯到会话/任务（历史来源标识）</span>
                ),
              },
              { key: "ip", label: "含义解读", span: 2, children: <span className="tiny">{detail.source?.interpretation}</span> },
            ]}
          />

          {detail.source?.resolved?.detail ? (
            <Descriptions
              size="small"
              column={2}
              bordered
              title={`回溯详情 (${detail.source.resolved.kind})`}
              items={Object.entries(detail.source.resolved.detail)
                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                .map(([k, v]) => ({ key: k, label: k, children: typeof v === "number" && v > 1e11 ? fmtTime(v) : String(v) }))}
            />
          ) : null}

          <Descriptions
            size="small"
            column={2}
            bordered
            title="质量与验证"
            items={[
              { key: "q", label: "质量分", children: <span className={styles.qualityNum} data-tone={qualityTone(detail.quality?.qualityScore).cls}>{detail.quality?.qualityScore ?? "-"}</span> },
              { key: "v", label: "验证状态", children: detail.quality?.verification ? <Tag color={VERIFY_TAG[detail.quality.verification]?.color}>{VERIFY_TAG[detail.quality.verification]?.label || detail.quality.verification}</Tag> : <span className="tiny">未验证</span> },
              { key: "hc", label: "人工确认", children: detail.quality?.humanConfirmed ? "是" : "否" },
              { key: "rc", label: "强化次数", children: fmtNum(detail.quality?.reinforceCount) },
              { key: "st2", label: "是否过期", children: detail.quality?.stale ? <Tag color="warning">已过期</Tag> : "否" },
              { key: "su", label: "被替代", children: detail.quality?.supersededBy ? <span className="mono tiny">{shortId(detail.quality.supersededBy)}</span> : "否" },
            ]}
          />

          <div>
            <div className={styles.sectionTitle}>使用记录（被哪些任务认领注入）</div>
            {detail.usage?.injections?.length ? (
              <Table
                size="small"
                rowKey={(r: any) => String(r.taskId) + r.at}
                pagination={false}
                dataSource={detail.usage.injections}
                columns={[
                  { title: "任务", dataIndex: "taskId", render: (v: string) => <span className="mono tiny">{v ? shortId(v, 12, 4) : "-"}</span> },
                  { title: t('lineage.col.agent'), dataIndex: "agentId", width: 130 },
                  { title: "注入条数", dataIndex: "count", width: 80, render: (v: number) => <span className="mono">{fmtNum(v)}</span> },
                  { title: "时间", dataIndex: "at", width: 150, render: (v: number) => <span className="tiny">{fmtTime(v)}</span> },
                ]}
              />
            ) : (
              <div className="tiny">
                暂无被认领/注入记录。
                {(detail.usage?.usageCount ?? 0) > 0 ? ` 该产物累计被引用 ${fmtNum(detail.usage.usageCount)} 次, 最近 ${relTime(detail.usage.lastUsedAt)}。` : ""}
              </div>
            )}
          </div>

          {detail.derived?.length ? (
            <div>
              <div className={styles.sectionTitle}>派生产物（用到了我）</div>
              <Table
                size="small"
                rowKey={(r: any) => r.table + r.id}
                pagination={false}
                dataSource={detail.derived}
                columns={[
                  { title: "类型", dataIndex: "table", width: 90, render: (v: string) => <span className={styles.tableLabel} data-table={v}>{TABLE_LABEL[v]}</span> },
                  { title: "标题", dataIndex: "title", render: (v: string) => <span className={styles.baseText}>{truncate(v, 40)}</span> },
                  { title: "质量", dataIndex: "qualityScore", width: 70, render: (v: number) => <span className="mono tiny">{v ? fmtScore(v) : "-"}</span> },
                  { title: "创建", dataIndex: "createdAt", width: 90, render: (v: number) => <span className="tiny">{relTime(v)}</span> },
                ]}
              />
            </div>
          ) : null}

          <div>
            <div className={styles.sectionTitle}>时间线</div>
            {(detail.timeline ?? []).length === 0 ? (
              <div className="tiny">没有关联事件</div>
            ) : (
              <Timeline
                items={(detail.timeline ?? []).slice(0, 14).map((t: any) => ({
                  color: t.kind === "create" ? "green" : t.kind === "use" ? "blue" : t.kind === "derive" ? "purple" : "gray",
                  content: (
                    <div className={styles.baseText}>
                      <div><b>{t.title}</b> <span className="tiny">{t.desc}</span></div>
                      <div className="tiny">{fmtTime(t.at)}</div>
                    </div>
                  ),
                }))}
              />
            )}
          </div>

          <details>
            <summary className={"tiny " + styles.summary}>查看全部字段（{detail.fields?.length ?? 0} 项）</summary>
            <Descriptions
              size="small"
              column={1}
              bordered
              className={styles.descTop}
              items={(detail.fields ?? []).map((f: any) => ({
                key: f.key,
                label: f.key,
                children: <span className={styles.fieldValue}>{String(f.value)}</span>,
              }))}
            />
          </details>
        </div>
      )}
    </Drawer>
  );
}
