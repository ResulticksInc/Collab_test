# Monitoring (scaffold)

Hooks for logs/metrics/traces. The backend already emits structured `[scope]` logs
and a standard error envelope. Add Prometheus metrics + a /metrics endpoint and OTel
traces here in the hardening sprint. Health is exposed at `GET /api/health`.
