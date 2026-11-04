/**
 * actor.ts — 写操作的"谁在操作"判据 (2026-09-11, 任务 cmtw9qgcq00jg1j7603hr98ed)
 *
 * 为什么要单独一份判据:
 *   实测 PL-AUTONOMY 被自己的自动化污染 —— 干预事件 `HUMAN_INTERVENTION` 只按 `by` 前缀判断,
 *   而 console 代理与脚本常把作者写成 `human:operator`, 于是**程序化调用被记成人类干预**,
 *   北极星指标被拉低(实测 0.825 < 0.9), 且无法事后区分。
 *
 * 规则(必须同时满足才算人类操作):
 *   1) 调用方显式声明 `x-actor-kind: human`(浏览器 UI 会带; 脚本默认不带);
 *   2) 事件里的 by/doneBy 以 `human` 开头。
 *   只满足 2) 而不满足 1) 视为**误标**: 不记 HUMAN_INTERVENTION, 改记 `ACTOR_MISLABELED`
 *   (可审计地暴露"谁自称人类"), 因此污染会显形而不是静默计入指标。
 *
 * 诚实边界: 本平台**没有鉴权**, 因此这个头是"约定"而不是"凭据" —— 有意的冒充仍可做到。
 *   它的价值是消除**无意污染**(默认值/复制粘贴脚本), 不是防攻击。需要防冒充必须先有身份认证。
 */
export type ActorKind = "human" | "agent" | "system";

export function resolveActor(req: Request, by?: string | null, fallback: ActorKind = "system") {
  const raw = String(by || "").trim();
  const headerKind = String(req.headers.get("x-actor-kind") || "").trim().toLowerCase();
  const claimsHuman = /^human/i.test(raw);
  // 2026-10-27 修: 原正则只认 `agent:` / `agent/`，而平台里 agent 的身份**普遍写成 `agent-<name>`**
  //   （实测 `Todo.doneBy LIKE 'agent-%'` 有 955 条）。于是 `agent-c` 被归为 fallback(system)，
  //   使"agent 不能结守门单"这类按 actor.kind 判的门**全部失效**（守门结单门首次实测就踩到）。
  const labeledAgent = /^agent[-:/]/i.test(raw);
  const isHuman = claimsHuman && headerKind === "human";
  const mislabeled = claimsHuman && headerKind !== "human";
  const kind: ActorKind = isHuman ? "human" : labeledAgent ? "agent" : fallback;
  const actor = raw || (kind === "human" ? "human:unknown" : kind === "agent" ? "agent:unknown" : "system:api");
  return { kind, actor, isHuman, mislabeled, claimedHuman: claimsHuman, headerKind };
}
