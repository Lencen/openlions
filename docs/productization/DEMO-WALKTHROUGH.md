# 可交付安装包 + 升级通道 —— 演示走查（DEMO）

> 这是可运行 dry-run 的**目标输出**（④ 演示）。实现后 `lions-install --dry-run` / `lions-upgrade --dry-run` / `lions doctor` 必须与本文一致或更清晰。
> 面向陌生人用业务语言，命令原文收在折叠块里（平台文案规范）。

---

## 场景 A：一台干净机器（已装 Node 20+ 与 pnpm）首次安装

```text
$ curl -fsSL https://<升级源>/install.sh | bash -s -- --home ~/lions

LIONS 安装向导
──────────────
[1/8] 环境检查
  ✓ Node v22.22.2（要求 ≥ 20）
  ✓ pnpm 9.15.9
  ✓ 可用磁盘 42.1 GB（要求 ≥ 5 GB）
  ✓ systemd --user 可用
  ! 目标端口 3000/3001/3002/3004/3006 全部空闲
  提示：开机自启需要执行  sudo loginctl enable-linger <你的用户名>（现在不做也不影响本次使用）

[2/8] 取安装包（渠道 stable，版本 0.1.0）
  下载 lions-0.4.33.tar.gz（28.4 MB）… 校验和 OK

[3/8] 解包到 ~/lions/releases/0.1.0

[4/8] 安装依赖（约 2–5 分钟）… 完成

[5/8] 生成数据库客户端并创建空数据库
  ✓ mind / session / selfimproving 数据目录已建

[6/8] 配置
  模型服务：MiniMax（可稍后改）
  请粘贴你的 API Key（不会写入日志）：••••••••
  ✓ 配置已写入 ~/lions/config（权限 600）

[7/8] 安装并启动服务
  ✓ mind (3000) / selfimproving (3001) / session (3002) / console (3004) / portal (3006)

[8/8] 健康检查
  ✓ 五个服务全部可访问
  ✓ 飞轮已开始工作（首次 tick 完成）

安装完成 🎉
  管理界面：http://127.0.0.1:3004/
  对外门户：http://127.0.0.1:3006/
  查看状态：lions doctor
  升级：    lions upgrade
```

<details><summary>命令原文</summary><pre>
curl -fsSL https://<升级源>/install.sh | bash -s -- --home ~/lions
node ~/lions/scripts/lions-install.cjs --from=... --home=~/lions
node ~/lions/scripts/lions-doctor.cjs
</pre></details>

---

## 场景 B：检查有没有新版本

```text
$ lions upgrade --check
当前版本：0.1.0（渠道 stable）
可升级到：0.2.0
本次修好：
  · 会话同步偶尔漏采一台机器（升级后自动补齐）
  · 管理界面某页在数据为空时显示成 0
执行升级：lions upgrade
```

---

## 场景 C：升级（含失败自动回滚）

```text
$ lions upgrade

LIONS 升级 0.1.0 → 0.2.0
─────────────────────────
[1/8] 预检 … ✓ 磁盘、端口、依赖、安装包校验和
[2/8] 备份 … ✓ 数据库已备份到 ~/lions/backups/20261015-1830
[3/8] 暂停服务 … ✓
[4/8] 安装新版本 … ✓
[5/8] 升级数据库 … ✓（2 项迁移）
[6/8] 构建 … ✓
[7/8] 启动并实测 … ✓ 五服务健康，实时数据未冻结
[8/8] 记录 … ✓

升级完成：0.2.0
```

失败路径（演练用）：
```text
[6/8] 构建 … ✗ 失败
  正在自动回滚…
  ✓ 已恢复数据库备份
  ✓ 已切回 0.1.0
  ✓ 五服务已恢复健康
回滚完成。没有数据丢失。诊断包：lions doctor --bundle
```

---

## 场景 D：自助排障

```text
$ lions doctor

LIONS 体检（版本 0.2.0，安装根 ~/lions）
────────────────────────────────────────
✓ 运行环境       Node v22.22.2 / pnpm 9.15.9
✓ 数据库         mind / session / selfimproving 均通过完整性检查
✓ 服务           mind 3000 · session 3002 · console 3004 · portal 3006
✗ 自改进服务     未运行（3001）
    建议：systemctl --user start lions-selfimproving；仍失败看 ~/lions/logs/selfimproving.log
! 模型配置       未设置 API Key —— 飞轮不会调用模型
    建议：编辑 ~/lions/config 或重跑 lions install --configure

要生成可发给支持人员的诊断包吗？它只包含系统状态与日志摘要（不含会话内容与密钥）：lions doctor --bundle ~/lions-doctor.tar.gz
```

---

## 边界声明（demo 也如实体现）

- 仅支持 Linux + systemd --user（v1）。
- 平台不提供大模型额度，需用户自带 key 或自部署。
- 数据默认留在本机；诊断包默认脱敏且需用户确认才生成。
