"use client";
// 2026-10-26：资产可见性设置页（console）。文案与降级规则见
//   docs/notes/2026-10-26-asset-visibility-copy-frozen.md（冻结），后端口径见 asset 文档 §19。
//
// 三个设计取舍（都来自 asset-line 对 mock 的核对）：
//   1. 平台未开放选择时**不渲染被禁用的单选控件** —— 禁用控件会让人以为点一下就能改；
//   2. 字段名（mode/fixedTo/存量计数来源）**不进界面**，只留用户能读的那半句；
//   3. 存量条数取不到时显示"未知"而**不是 0**，且**不阻止切换** ——
//      「未知」与「没有存量」是两件事，显示 0 等于告诉用户切换零代价。
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Skeleton, Tag } from "@/components/primitives";
import { useApi } from "@/lib/api";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

type Kind = "memory" | "knowledge" | "skill";

interface KindPolicy {
  mode?: string;
  selectable?: boolean;
  fixedTo?: string | null;
  defaultMode?: string | null;
}

interface PolicyResp {
  ok?: boolean;
  types?: Record<string, KindPolicy>;
  hint?: string | null;
  error?: string;
}

interface OwnerlessResp {
  ok?: boolean;
  counts?: Record<Kind, number | null> | null;
  stale?: boolean;
  asOf?: string | null;
  reason?: string;
}

const KINDS: { key: Kind; name: string }[] = [
  { key: "memory", name: "记忆" },
  { key: "knowledge", name: "知识" },
  { key: "skill", name: "技能" },
];

const MODE_LABEL: Record<string, string> = {
  public: "全平台可见",
  private: "仅所属执行体可见",
};

const HELP = "该类型由平台统一配置，单个执行体不能自行更改；如需调整请联系平台管理员。";

const fmtNum = (n: number) => n.toLocaleString("zh-CN");

export default function AssetVisibilityPage() {
  const { data, loading, error } = useApi<PolicyResp>("/api/asset-policy");
  // 存量条数只在"准备切私有"时才需要；这里仍提前取一次，避免弹窗打开时空白
  const ownerless = useApi<OwnerlessResp>("/api/asset-policy/ownerless");

  const [dialog, setDialog] = useState<Kind | null>(null);
  const [pending, setPending] = useState<Kind | null>(null);
  const [saving, setSaving] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const types = data?.types ?? {};
  const counts = ownerless.data?.counts ?? null;
  const stale = ownerless.data?.stale === true;

  const anySelectable = useMemo(() => KINDS.some((k) => types[k.key]?.selectable === true), [types]);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) setDialog(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, saving]);

  async function confirmSwitch(kind: Kind) {
    setSaving(true);
    setPending(kind);
    try {
      const r = await fetch("/api/asset-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, mode: "private", confirmed: true }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || j.ok === false) {
        setDoneMsg(j.error || "切换没有完成，请重试或联系平台管理员");
      } else {
        const name = KINDS.find((k) => k.key === kind)?.name ?? "该类型";
        setDoneMsg(`已提交：${name}的可见性改为「仅所属执行体可见」`);
        setDialog(null);
        ownerless.mutate?.();
      }
    } catch {
      setDoneMsg("切换没有完成，请重试或联系平台管理员");
    } finally {
      setSaving(false);
      setPending(null);
    }
  }

  const dialogKind = dialog ? KINDS.find((k) => k.key === dialog) : null;
  const dialogCount = dialog ? counts?.[dialog] ?? null : null;

  return (
    <div className="layout-with-sidebar"><main className="main">
      <PageHeader>
        <div>
          <PageTitle>资产可见性</PageTitle>
          <div className="page-subtitle">记忆、知识、技能三类 · 由平台统一配置</div>
        </div>
      </PageHeader>

      {doneMsg ? (
        <Alert type="success" showIcon title={doneMsg} closable onClose={() => setDoneMsg(null)} style={{ marginBottom: "var(--gap-block)" }} />
      ) : null}

      {error ? (
        <Alert
          type="warning"
          showIcon
          title="策略暂时取不到"
          description="这不影响已有资产的使用；稍后刷新本页即可。"
          style={{ marginBottom: "var(--gap-block)" }}
        />
      ) : null}

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">当前策略</div>
        </div>

        {loading ? (
          <Skeleton paragraph={{ rows: 3 }} />
        ) : (
          <>
            <p className="tiny" style={{ marginTop: 0 }}>
              平台已将「记忆、知识、技能三类」统一配置为「全平台可见」。单个执行体不能自行更改；如需调整请联系平台管理员。
            </p>

            {KINDS.map((k) => {
              const p = types[k.key];
              const mode = p?.mode ?? "public";
              const selectable = p?.selectable === true;
              return (
                <div
                  key={k.key}
                  className="dt-row"
                  style={{ alignItems: "center", display: "flex", gap: "var(--gap-block)", paddingBlock: "var(--gap-tight)" }}
                >
                  <div style={{ width: 96, fontWeight: 600 }}>{k.name}</div>
                  <div style={{ flex: 1 }}>
                    {selectable ? (
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: "var(--gap-label)" }}>由你决定</div>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: "var(--gap-block)" }}>
                          <input type="radio" name={"mode-" + k.key} checked={mode !== "private"} readOnly />
                          公开（全平台可见）
                        </label>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="radio"
                            name={"mode-" + k.key}
                            checked={mode === "private"}
                            onChange={() => setDialog(k.key)}
                          />
                          私有（仅所属执行体可见）
                        </label>
                        <div className="tiny" style={{ marginTop: "var(--gap-label)" }}>
                          仅在平台允许时可选，默认{/* 默认值取后端给的档位，不自行假定 */}
                          {MODE_LABEL[p?.defaultMode || "public"] ?? "全平台可见"}。
                        </div>
                      </div>
                    ) : (
                      <>
                        <Tag color="green">{MODE_LABEL[mode] ?? "全平台可见"}</Tag>
                        <span className="tiny" style={{ marginLeft: "var(--gap-label)" }}>
                          不可选（平台统一配置）
                        </span>
                        <span
                          className="tiny"
                          title={HELP}
                          aria-label={HELP}
                          style={{
                            marginLeft: "var(--gap-label)",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            border: "1px solid var(--border)",
                            cursor: "help",
                          }}
                        >
                          ?
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {anySelectable ? (
        <div className="panel" style={{ marginTop: "var(--gap-block)" }}>
          <div className="panel-header">
            <div className="panel-title">切换说明</div>
          </div>
          <div className="tiny">切换只影响此后新写入的资产；没有归属执行体的历史资产仍保持公开。</div>
        </div>
      ) : null}

      {dialogKind ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`将${dialogKind.name}切换为仅所属执行体可见`}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(16,24,40,.32)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 60,
          }}
          onClick={() => (saving ? null : setDialog(null))}
        >
          <div
            className="panel"
            style={{ width: 560, maxWidth: "92vw", background: "var(--bg-panel, #fff)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-header">
              <div className="panel-title">{`将「${dialogKind.name}」切换为「仅所属执行体可见」？`}</div>
            </div>
            <div style={{ padding: "0 var(--gap-sect) var(--gap-block)" }}>
              {dialogCount === null ? (
                <p style={{ marginTop: 0 }}>
                  存量条数未知（不影响切换，仅影响提示精度）。切换后，无归属执行体的历史资产仍保持公开（只影响此后新写入）。确认切换？
                </p>
              ) : (
                <p style={{ marginTop: 0 }}>
                  当前存量中有 <b>{fmtNum(dialogCount)}</b> 条历史资产没有归属执行体，切换后它们仍保持公开（只影响此后新写入）。确认切换？
                </p>
              )}

              {ownerless.loading ? <div className="tiny">正在取存量条数…</div> : null}
              {stale && dialogCount !== null ? (
                <div className="tiny" style={{ marginBottom: "var(--gap-label)" }}>
                  数据可能不是最新{doneMsg ? "" : "（上游暂时取不到，显示的是上次结果）"}
                </div>
              ) : null}
              {dialogCount === null && !ownerless.loading ? (
                <div className="tiny" style={{ marginBottom: "var(--gap-label)" }}>
                  为什么显示「未知」而不是 0：未知与「没有存量」是两件事；显示 0 等于告诉您切换零代价。切换动作不依赖这个数，仍可正常确认。
                </div>
              ) : null}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--gap-label)", marginTop: "var(--gap-block)" }}>
                <Button onClick={() => setDialog(null)} disabled={saving}>
                  取消
                </Button>
                <Button type="primary" onClick={() => confirmSwitch(dialogKind.key)} loading={saving && pending === dialogKind.key}>
                  确认切换
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main></div>
  );
}
