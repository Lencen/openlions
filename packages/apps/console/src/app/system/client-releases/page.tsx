"use client";
// 2026-10-29 客户端版本管理（console）。
// 契约：docs/productization/CLIENT-RELEASE-SERVICE-2026-10-29.md
// 口径：服务未接入 → 明确写"未接入"，不写"暂无数据"；未签名包也要可见（否则被误读成"没这个版本"）。
import { Alert, Skeleton, Tag } from "@/components/primitives";
import { useApi } from "@/lib/api";

interface Release {
  id?: string;
  version?: string;
  platform?: string;
  arch?: string;
  filename?: string;
  sizeBytes?: number;
  sha256?: string;
  // 2026-10-30 修正：服务返回的是 signed(boolean) 与 key_id，不是 signature/signed_by。
  // 之前页面读 signature -> 恒为空 -> 每行都显示"未签名"（而发布时其实自动签了）。
  signed?: boolean;
  key_id?: string | null;
  state?: string;
  channel?: string;
  notes?: string;
  publishedAt?: string | null;
}
interface Resp {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  items?: Release[];
  latest?: Release | null;
  asOf?: string;
}

const STATE_LABEL: Record<string, string> = {
  draft: "草稿",
  pending_sign: "待签名",
  signed: "已签名待发布",
  published: "已发布",
  deprecated: "已弃用",
  revoked: "已撤销",
};

// 2026-10-30：安装包只有几 KB 时，MB 保留一位会显示 "0.0 MB"——等于没显示。
const fmtSize = (n?: number) => {
  if (typeof n !== "number") return "未知";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const short = (s?: string | null) => (s ? String(s).slice(0, 16) : "—");

export default function ClientReleasesPage() {
  const { data, loading, error } = useApi<Resp>("/api/client-releases", { pollMs: 30000 });
  const items = data?.items ?? [];

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="page-header">
        <div className="page-title">客户端版本</div>
        <div className="page-subtitle">
          发布即签名；portal 只展示最新版。数据时刻 {data?.asOf ? String(data.asOf).slice(0, 19).replace("T", " ") : "—"}
        </div>
      </div>

      {error ? (
        <Alert type="warning" showIcon title="读数暂时取不到" description="这不代表没有版本；稍后刷新即可。" />
      ) : loading ? (
        <Skeleton paragraph={{ rows: 6 }} />
      ) : data?.available === false ? (
        <Alert
          type="info"
          showIcon
          title="发布服务未接入"
          description={data.reason || "客户端版本管理服务尚未上线；此处不显示「暂无数据」，因为那会被读成「没有发布过任何版本」。"}
        />
      ) : items.length === 0 ? (
        <Alert type="warning" showIcon title="还没有任何发布记录" description="服务已接入，但没有任何版本登记（draft 也会出现在这张表里）。" />
      ) : (
        <div className="panel">
          <div className="panel-header"><div className="panel-title">全部版本（含未签名与已撤销）</div></div>
          <div style={{ padding: "var(--gap-sect)" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>版本</th><th>平台 / 架构</th><th>大小</th><th>校验和</th>
                  <th>签名</th><th>状态</th><th>通道</th><th>发布</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={r.id || i}>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{r.version || "—"}</td>
                    <td>{[r.platform, r.arch].filter(Boolean).join(" / ") || "—"}</td>
                    <td>{fmtSize(r.sizeBytes)}</td>
                    <td className="tiny" style={{ fontFamily: "var(--font-mono)" }}>{short(r.sha256)}</td>
                    <td>
                      {/* 2026-10-30：未知 ≠ 否。字段缺失时不能说"未签名"（那是确定的反面结论），只能显示"未知"。 */}
                      {r.signed === true ? (
                        <Tag color="green">已签名</Tag>
                      ) : r.signed === false ? (
                        <Tag color="red">未签名</Tag>
                      ) : (
                        <Tag color="gray">签名状态未知</Tag>
                      )}
                      {r.key_id ? <div className="tiny" style={{ marginTop: 2, fontFamily: "var(--font-mono)" }}>key_id {String(r.key_id).slice(0, 16)}</div> : null}
                    </td>
                    <td>
                      <Tag color={r.state === "published" ? "green" : r.state === "revoked" ? "red" : "gold"}>
                        {STATE_LABEL[String(r.state)] || r.state || "—"}
                      </Tag>
                    </td>
                    <td className="tiny">{r.channel || "—"}</td>
                    <td className="tiny">{r.publishedAt ? String(r.publishedAt).slice(0, 19).replace("T", " ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tiny" style={{ marginTop: "var(--gap-label)" }}>
              未签名的包也会出现在这里——「未签名」与「没有这个版本」是两件事。
            </div>
          </div>
        </div>
      )}
    </main></div>
  );
}
