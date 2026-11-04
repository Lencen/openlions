import { execFileSync } from "child_process";

const REPO = "~/lions";

function git(args: string[], timeout = 4000): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, { cwd: REPO, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: String(out || "").trim() };
  } catch (e: any) {
    return { ok: false, out: String((e && e.stdout) || "").trim() };
  }
}

export type ShaVerdict = { ok: boolean; sha: string | null; reason: string };

/**
 * 校验结单证据里的 commit sha（2026-10-23）。
 *   1) 必须是仓库里真实存在的提交；
 *   2) 若知道 owner：该提交必须属于 owner —— 是 owner 名下分支的祖先，或 author/committer 是 owner。
 * 为什么需要第 2 条：只校验"存在"时，任何一条真 sha（哪怕是我的）都能替别人结单。
 */
export function verifyCommitSha(evidence: string, ownerId?: string | null): ShaVerdict {
  const sha = (String(evidence || "").match(/\b[0-9a-f]{7,40}\b/i) || [])[0] || null;
  if (!sha) return { ok: false, sha: null, reason: "缺少 commit sha（7-40 位十六进制）" };
  if (!git(["cat-file", "-e", sha + "^{commit}"]).ok) return { ok: false, sha, reason: "sha 不在仓库中" };
  const owner = String(ownerId || "").trim();
  if (!owner) return { ok: true, sha, reason: "ok（未提供 owner，只校存在性）" };

  // 分支名单：agent/agent-e、agent/agent-e-*、agent/agent-x-* 等
  const refs = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out.split("\n").filter(Boolean);
  const tokens = [owner, owner.replace(/^agent-/, "")].filter(Boolean);
  const branches = refs.filter((b) => tokens.some((t) => b.includes(t)));
  for (const b of branches) {
    if (git(["merge-base", "--is-ancestor", sha, b]).ok) return { ok: true, sha, reason: "ok（属于 " + b + "）" };
  }
  // 兜底：提交作者/提交者署名是 owner（agent-x 那次就是这么提交的）
  const who = git(["show", "-s", "--format=%an|%cn|%ae|%ce", sha]).out;
  if (who && tokens.some((t) => who.includes(t))) return { ok: true, sha, reason: "ok（署名匹配 owner）" };
  return { ok: false, sha, reason: "该提交不属于 " + owner + "（不在其分支上，署名也不匹配）" };
}
