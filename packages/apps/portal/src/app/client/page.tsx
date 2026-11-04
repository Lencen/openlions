import Link from "next/link";

// 2026-10-29 客户端下载（portal）。
// 老板口径：**portal 只提供最新客户端**，用于接入终端首次安装；历史版本只在 console。
// 数据源：客户端发布服务的 latest；未接入时明确写"尚未发布安装包"，不编造下载链接。
export const dynamic = "force-dynamic";

type Latest = {
  version?: string;
  sha256?: string;
  published_at?: string;
  filename?: string;
  size_bytes?: number;
};

async function fetchLatest(): Promise<{ ok: boolean; latest: Latest | null; version?: string; reason?: string }> {
  const base = process.env.LIONS_MIND_URL || "http://127.0.0.1:3000";
  try {
    const r = await fetch(`${base}/api/v1/client/releases/latest?platform=linux-deb`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      const b = (await r.json()) as { latest?: Latest };
      return { ok: true, latest: b.latest ?? null };
    }
    const v = await fetch(`${base}/api/v1/flywheel/client/version`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    const vb = v.ok ? ((await v.json()) as { version?: string }) : {};
    // 2026-10-29 21:20 修正：404 有两种，必须看 body
    //   · HTML 404 → 路由未部署；· JSON 404 → 已接入但尚无已发布版本
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let reason = "发布服务未接入";
    if (ct.includes("application/json")) {
      let upstream = "";
      try {
        upstream = String(((await r.json()) as Record<string, unknown>)?.error ?? "");
      } catch {
        upstream = "";
      }
      reason =
        upstream === "NO_PUBLISHED_RELEASE"
          ? "发布服务已接入，尚无已发布版本"
          : "发布服务已接入，尚无任何客户端版本";
    } else {
      reason = "发布服务路由不存在（mind 未部署）";
    }
    return { ok: false, latest: null, version: vb.version, reason };
  } catch {
    return { ok: false, latest: null, reason: "发布服务不可达" };
  }
}

export default async function ClientDownloadPage() {
  const { ok, latest, version, reason } = await fetchLatest();
  const ver = latest?.version || version;

  return (
    <main className="page page--narrow" style={{ paddingTop: 32, paddingBottom: 64 }}>
      <h1 className="title-sm">接入客户端</h1>
      <p className="muted" style={{ marginTop: 8 }}>
        首次安装请使用下方最新客户端。安装完成后，终端在平台注册并通过审批即可接入。
      </p>

      <div className="panel" style={{ marginTop: 24, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>最新版本</div>
          <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 18 }}>{ver || "未知"}</div>
          {ok && latest?.published_at ? (
            <span className="muted" style={{ fontSize: 12 }}>
              发布于 {String(latest.published_at).slice(0, 10)}
            </span>
          ) : null}
        </div>

        {!ok ? (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--text-dim)" }}>
            尚未发布安装包（{reason || "发布服务未接入"}）。当前可用的是自更新版本 {ver || "未知"}；
            安装包发布后此页会自动出现下载按钮。
          </div>
        ) : (
          <>
            <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a
                href={`/api/client-download?platform=linux-deb&v=${encodeURIComponent(ver || "")}`}
                style={{ padding: "10px 18px", borderRadius: 8, background: "var(--primary)", color: "var(--on-primary)", textDecoration: "none", fontWeight: 600 }}
              >
                下载 Linux（deb）
              </a>
              <span style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid var(--border-1, var(--border-soft, #e2e8f0))", color: "var(--text-dim)" }}>
                Windows / macOS：暂未提供
              </span>
            </div>
            <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.8 }}>
              <div>文件：{latest?.filename || "—"}（{latest?.size_bytes ? `${(latest.size_bytes / 1024 / 1024).toFixed(1)} MB` : "大小未知"}）</div>
              <div>校验：<code>{latest?.sha256 ? String(latest.sha256).slice(0, 32) + "…" : "—"}</code>（下载后请核对 sha256）</div>
              <div>安装：<code>sudo dpkg -i lions-client_{ver}_amd64.deb</code></div>
            </div>
          </>
        )}
      </div>

      <div className="panel" style={{ marginTop: 16, padding: 20, fontSize: 13, lineHeight: 1.9, color: "var(--text-dim)" }}>
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>安装前需要准备</div>
        <div>1. 一台 Linux 终端（当前提供 amd64：Ubuntu / UOS 均可）；</div>
        <div>2. 终端能访问平台地址；</div>
        <div>3. 一个已审批的 agent 身份（未注册的终端只能装包，不能接入）。</div>
        <div style={{ marginTop: 8 }}>
          接入流程见 <Link href="/guide" style={{ color: "var(--primary)" }}>接入手册</Link>，注册入口 <Link href="/register" style={{ color: "var(--primary)" }}>Agent 注册</Link>。
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-dim)" }}>
        本页只提供<strong>最新</strong>版本；历史版本与签名状态请在平台控制台的「客户端版本」页查看。
      </div>
    </main>
  );
}
