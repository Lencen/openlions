# Contributing to LIONS

LIONS is an **agent-first** platform: agents are the primary users and data producers/consumers; humans are the platform managers. Contributions are welcome from humans and agents alike.

> This project is **100% vibecoding**: humans set goals, boundaries and acceptance criteria; agents write code, run checks and fix regressions. A contribution is judged by reproducible evidence, not by who (or what) wrote it.

## 1. What can you contribute?

- A new **session source** (Claude Code, Codex, OpenClaw, Hermes, DSH, or another format).
- A new **agent adapter** or client integration (session sync + task claim/submit).
- A **module** improvement: memory, knowledge, reflection, practice, skill, pipeline, flywheel, task.
- **Docs** for installation, upgrade, troubleshooting, model config, or data usage.
- **Bug fixes** with a reproducible command and a failing/passing check.

Not in the open-source scope: MACS cross-agent messaging, mcp-server, doc-portal. Do not add them to this repository.

## 2. Prerequisites

- Linux (systemd --user recommended) or macOS for development.
- Node.js **20+**; pnpm **9.15.9** via corepack.
- PostgreSQL **16** (required by the app; the release medium can carry it).
- Python 3.10+ for session sync and the open client.

    git clone https://github.com/operator/lions-open-source.git
    cd lions-open-source
    corepack enable
    corepack prepare pnpm@9.15.9 --activate
    pnpm install --no-frozen-lockfile

There is intentionally no committed lockfile in the open-source export. Do not add one that references closed packages.

## 3. Local development

Start PostgreSQL first, then set:

    export MIND_DATABASE_URL=postgresql://lions:<password>@127.0.0.1:5432/lions_mind
    export SESSION_DATABASE_URL=postgresql://lions:<password>@127.0.0.1:5432/lions_session
    export SELFIMPROVING_DATABASE_URL=postgresql://lions:<password>@127.0.0.1:5432/lions_selfimproving
    export MIND_DB_DRIVER=pg

Generate Prisma clients and build:

    pnpm --filter @lions/mind prebuild
    pnpm --filter @lions/session prebuild
    pnpm --filter @lions/selfimproving prebuild
    pnpm -r build

Run individual apps:

    pnpm --filter @lions/mind dev        # 3000
    pnpm --filter @lions/session dev     # 3002
    pnpm --filter @lions/selfimproving dev # 3001
    pnpm --filter @lions/console dev     # 3004
    pnpm --filter @lions/portal dev      # 3006

## 4. Checks before a PR

    pnpm --filter @lions/mind typecheck
    pnpm --filter @lions/session typecheck
    pnpm --filter @lions/console typecheck
    pnpm --filter @lions/selfimproving exec tsc --noEmit
    pnpm --filter @lions/portal exec tsc --noEmit
    pnpm -r build

For installer changes, also run:

    node scripts/lions-install.cjs --selftest
    node scripts/test-lions-install.cjs
    node scripts/lions-pack.cjs --selftest

For export/governance changes:

    node scripts/check-open-source-readiness.cjs
    node scripts/check-open-source-boundary.cjs
    node scripts/scan-open-source-sensitive.cjs --root=<export>

## 5. Pull request rules

1. **One concern per PR**; include the command(s) you ran and the output that proves the change.
2. **No secrets, internal hostnames, IPs, user names, or real customer data.** Use placeholders such as agent-demo and example.com.
3. **No closed packages**: do not import MACS, portal internal pages, mcp-server, or doc-portal.
4. **Schema changes** must include a migration and a note on upgrade impact.
5. **Docs changes** must not reintroduce internal productization/business docs.
6. By contributing you agree your contribution is licensed under **Apache-2.0** (inbound = outbound). No CLA is required.

Recommended commit style:

    feat(scope): short summary
    fix(scope): short summary
    docs(scope): short summary

## 6. Agent contributions

Agents are first-class contributors. An agent contribution must:

- state the goal and the acceptance criterion;
- include a **reproducible** command/check, not just prose;
- keep secrets out of logs and commits;
- not bypass tests by editing baselines without a reason.

If an agent wrote the change, say so in the PR description. That is expected, not a problem.

## 7. Reporting security issues

Please do **not** open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).

## 8. Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
