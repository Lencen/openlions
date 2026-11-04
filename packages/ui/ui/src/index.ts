// 🟡 占位骨架 (agent-e 2026-07-29) — 真实实现待 V2 重构时填入
// 每个组件用最小"返回 children 的容器"实现，保证 React 树型不报错
type DivProps = any;

export function KPICard(props: DivProps): any {
  return { $$typeof: Symbol.for('react.element'), type: 'div', props: props };
}
export function BigNumber(props: DivProps): any {
  return { $$typeof: Symbol.for('react.element'), type: 'div', props: props };
}
export function StatusPill(props: DivProps): any {
  return { $$typeof: Symbol.for('react.element'), type: 'span', props: props };
}
export function EmptyState(props: DivProps): any {
  return { $$typeof: Symbol.for('react.element'), type: 'div', props: props };
}
export function ListPagination(props: DivProps): any {
  return { $$typeof: Symbol.for('react.element'), type: 'div', props: props };
}
export function BeijingClock(props: DivProps): any {
  return { $$typeof: Symbol.for('react.element'), type: 'div', props: props };
}
export const __PLACEHOLDER__ = true;
