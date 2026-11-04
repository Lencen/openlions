// RBAC 预留: 当前 pass-through, 未来接入权限系统
export function hasPermission(perm: string): boolean {
  return true; // pass-through
}

export function isLocked(perm: string, locked?: boolean): boolean {
  if (locked) return true;
  return !hasPermission(perm);
}
