/**
 * guard-todo-close-gate.ts — 守门待办的结单权限判据（2026-10-27）
 *
 * 为什么需要（真实事故）:
 *   `todo_plautonomy_mvkhv3in` 是 PL-AUTONOMY 守门开的红单。guard 因类型错退化成 iv=0、
 *   读成 PASS 后自动结单；随后 agent-c 又以「旧数据已被最新现场数据取代」为由再次结单，
 *   而当时 autonomy_proxy=0.929 仍低于目标 0.95 —— **红单被"换了个新数字"结掉**。
 *   已有的证据门只校验"有没有证据/锚点"，挡不住"用新读数论证旧问题已消失"这种结单理由。
 *
 * 判据:
 *   source 以 `_guard` / `_guard_test` 结尾的待办，**只允许**人类或 system（守门自身）结单；
 *   agent 一律拒绝。守门自身走直连写库、不经过本 API，因此不受影响。
 *
 * 诚实边界:
 *   本平台没有鉴权，`x-actor-kind` 与 by 前缀是**约定**而非凭据（见 actor.ts 同一说明）。
 *   本门消除的是"agent 以数字变化为由结掉红单"这类**无意识**行为，不是防冒充。
 */

export type CloseActor = { kind?: string; actor?: string };

/** 守门来源：`pl_autonomy_guard` / `pl_trust_guard` / `fw_quality_guard` / `*_guard_test` */
export function isGuardSource(source: unknown): boolean {
  return /_(guard)(_test)?$/.test(String(source || ""));
}

/**
 * 是否允许该 actor 把该来源的待办置 DONE。
 * @returns { allowed, reason }
 */
export function canCloseTodo(source: unknown, actor: CloseActor): { allowed: boolean; reason: string } {
  const src = String(source || "");
  if (!isGuardSource(src)) return { allowed: true, reason: "非守门来源，不适用" };
  const kind = String(actor && actor.kind || "").toLowerCase();
  const who = String(actor && actor.actor || "");
  if (kind === "human") return { allowed: true, reason: "人类结单" };
  // 守门自身：system 身份（守门 cron 用 system:pl-autonomy-guard-cron 之类）
  if (kind === "system" || /guard/i.test(who)) return { allowed: true, reason: "守门自身结单" };
  return {
    allowed: false,
    reason: "守门来源的待办只能由守门自身或人类结单；agent 不能以「数字变了」结掉红单（" +
      "请让守门重新判定为 PASS，或由人类复核后结单）",
  };
}
