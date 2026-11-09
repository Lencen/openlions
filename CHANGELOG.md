# Changelog

All notable changes to the open-source edition.

## 0.4.40-open.1 — 2026-11-09

- First open-source snapshot: mind / session / selfimproving / console / portal public pages + modules.
- Portal public pages: home, agents, guide, register, client, docs. Internal report/knowledge/daily-report/ingest are not exported.
- Open client subset: session sync + task claim/heartbeat/submit/release; no MACS cross-agent messaging.
- PostgreSQL required; install medium can carry PostgreSQL (docker run / compose / deb).
- Per-deployment bootstrap/admin keys and Ed25519 client-release signing key (0600).
- Installer: upgrade / doctor / uninstall / pack; 5 services health checks.
- Agent onboarding: claim ticket -> claim-service-key; console approvals for PENDING agents.
