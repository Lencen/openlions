"use client";
// system/api 页 · MCP 服务表 (可展开工具行) (从 page.tsx 抽出, 页面瘦身)
// 2026-11-05 P2 批6：裸表格清零 —— 改用同族底层 primitives.Table（支持 expandable/onRow），
//   内联 style 清零并下沉 ./McpServiceTable.module.css。
//   为什么不走白名单 DataTable：本表必须「点服务行整行展开工具列表」，白名单 DataTable 目前只有
//   columns/rows/rowKey/loading/empty/error/onRetry，没有 expandable；而登记例外 E1 的那层
//   DataTable 薄封装（components/common 子目录）已用满 10 个文件、只减不增，不能再加第 11 个。
//   故直接用 E1 薄封装所包的同族原子 Table：页面级表格标签归零，E1 计数仍为 10（本文件不新增 E1）。
//   行为等价：行点击展开/收起（可多行同时展开）、展开区内点工具进入调测、复制表格按钮仍在表前。
//   列与字段一条不少（服务名/显示名/版本/端点/权限/工具/状态）。取数、文案未动。
import { useState } from "react";
import { t } from "@/i18n";
import type { McpTool, Svc } from "./types";
import { Table } from "@/components/primitives";
import type { TableColumn } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import styles from "./McpServiceTable.module.css";

function permText(p: any) {
  if (typeof p === "string") {
    try {
      return JSON.parse(p).join(", ");
    } catch {
      return p;
    }
  }
  return Array.isArray(p) ? p.join(", ") : "-";
}

export default function McpServiceTable({
  services,
  toolsByService,
  onPickTool,
}: {
  services: Svc[];
  toolsByService: Record<string, McpTool[]>;
  onPickTool: (t: McpTool) => void;
}) {
  // 展开态按服务名记：与改前一致，允许多行同时展开
  const [open, setOpen] = useState<string[]>([]);
  const toggle = (name: string) =>
    setOpen((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));

  // 列：与改前表头逐列对应（表头多出的首列是 Table 自带的展开箭头列，改前也是同一位置的空列）
  const columns: TableColumn<Svc>[] = [
    { key: "name", title: "服务名", render: (_v, s) => <b className={styles.mstNowrap}>{s.name}</b> },
    { key: "display_name", title: "显示名", render: (_v, s) => <span className={styles.mstNowrap}>{s.display_name}</span> },
    { key: "version", title: "版本", render: (_v, s) => <span className={"mono " + styles.mstSm}>{s.version}</span> },
    { key: "endpoint", title: "端点", render: (_v, s) => <span className={styles.mstEndpoint}>{s.endpoint}</span> },
    { key: "perms", title: "权限", render: (_v, s) => <span className={styles.mstSm}>{permText(s.available_perms)}</span> },
    {
      key: "tools",
      title: "工具",
      render: (_v, s) => <span className="badge badge-blue">{(toolsByService[s.name] || []).length}</span>,
    },
    {
      key: "status",
      title: "状态",
      render: (_v, s) => (
        <span className={"badge " + (s.status === "ACTIVE" ? "badge-green" : "badge-yellow")}>{s.status}</span>
      ),
    },
  ];

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{t('api.panel.mcp')}</span>
        <span className={styles.mstHint}>
          点击服务行展开工具，再点击工具进入调测
        </span>
      </div>
      <TableCopyButton />
      <Table<Svc>
        dataSource={services}
        rowKey={(s) => s.name}
        pagination={false}
        columns={columns}
        onRow={(s) => ({ onClick: () => toggle(s.name), className: styles.mstRow })}
        expandable={{
          // 受控展开：按钮点开/点收都回写同一份状态；整行点击走 onRow（按钮自带 stopPropagation，不会双触发）
          expandedRowKeys: open,
          onExpandedRowsChange: (keys) => setOpen(keys.map(String)),
          expandedRowRender: (s) => {
            const tools = toolsByService[s.name] || [];
            return (
              <div className={styles.mstToolPanel}>
                {tools.length === 0 ? (
                  <div className={styles.mstEmptyTools}>
                    暂无可用工具 (服务未返回 tools/list)
                  </div>
                ) : (
                  <div className={styles.mstToolGrid}>
                    {tools.map((tool) => (
                      <div key={tool.name} className={styles.mstToolCard} onClick={() => onPickTool(tool)}>
                        <div className={styles.mstToolName}>🔧 {tool.name}</div>
                        {tool.description && (
                          <div className={styles.mstToolDesc}>
                            {tool.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          },
        }}
      />
    </div>
  );
}
