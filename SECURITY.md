# Security Policy

## Supported versions

Only the **latest release** of GhostBus is supported with security fixes.
If you are running an older version, upgrade first — the fix will land on
the newest release, not on backports.

## Reporting a vulnerability

Email **gdev6145@gmail.com** with:

- what you found and where (file, endpoint, or hosted route),
- the version you tested,
- steps to reproduce, if you have them.

Please do not open a public issue for a security report, and give us a
chance to fix it before disclosing publicly.

**What to expect:** an acknowledgement within **one business day**, and a
plain-language answer about whether we can reproduce it and what happens
next. GhostBus is built by Ghost Developer Studio — a one-person studio —
so fixes are prioritized by real-world impact, but every report gets read
by the person who wrote the code.

## Scope notes

- Self-hosted deployments are operated by whoever runs them; the operator
  guidance for the hosted server (keys, HTTPS, throttling, backups) lives
  in [`docs/hosted.md`](docs/hosted.md), in the "Security & deployment
  hardening" section.
- Workspace keys and agent tokens are only ever stored as SHA-256 hashes;
  a report based on reading your own data files is your deployment working
  as designed, not a leak.
- The counts-only `/probe` and `/health` endpoints are intentionally
  unauthenticated for monitoring; they expose no message, task, or file
  content.
