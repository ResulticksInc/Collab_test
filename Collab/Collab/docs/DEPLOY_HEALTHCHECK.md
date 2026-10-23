## I. Root-Cause Analysis Flow (When Calls/Meetings Suddenly Break)

Use this flow whenever calls or meetings fail after deployment. Do **not** immediately rollback. First identify which layer is actually failing.

### Incident Signature Matrix

| Symptom                                                  | Most Likely Cause                                |
| -------------------------------------------------------- | ------------------------------------------------ |
| Calls fail on external network only                      | TURN / Coturn / Firewall                         |
| Calls fail on VPN and external networks                  | LiveKit / Token / Signalling                     |
| Meetings fail but chat works                             | LiveKit / Token Generation                       |
| Login works, calls fail everywhere                       | LiveKit API Secret mismatch                      |
| Calls fail immediately after deploy, then recover later  | LiveKit restart / readiness race                 |
| Calls fail before and after rollback, then recover later | Infrastructure convergence, not application code |
| Media error for all users simultaneously                 | SFU unavailable or token validation failure      |
| Chat works, notifications work, calls fail               | Media plane issue, not backend issue             |

---

## J. Deployment Failure Investigation Sequence

If users report call failures after deployment:

### Step 1 - Verify Whether This Is Application Or Infrastructure

Ask:

```text
Did rollback immediately fix the problem?
```

If:

```text
Deploy -> Broken
Rollback -> Fixed
```

Likely application issue.

If:

```text
Deploy -> Broken
Rollback -> Still Broken
Wait
Starts Working
```

Almost certainly infrastructure/media-plane issue.

This distinction is critical.

A genuine code bug usually disappears immediately after rollback.

Infrastructure issues often survive rollback because rollback triggers another restart cycle.

---

### Step 2 - Check Backend Status

```bash
docker logs --tail 100 colab-backend
```

Look for:

```text
[boot] FATAL
Migration failed
LIVEKIT_WS_URL
AUTH_JWT_SECRET
LIVEKIT_API_SECRET
```

If backend is not healthy:

```text
No token generation
No room creation
Calls fail everywhere
```

---

### Step 3 - Verify LiveKit Is Actually Ready

Container running does NOT mean LiveKit is ready.

Check:

```bash
docker ps
```

Then:

```bash
docker logs --tail 100 colab-livekit
```

Look for:

```text
node registered
server started
listening
```

Do not rely on:

```text
Up 5 seconds
```

as proof of readiness.

---

### Step 4 - Verify Media Ports

```bash
ss -lntu | grep -E '7531|7532|7533'
```

Expected:

```text
TCP 7531
UDP 7532
UDP 7533
```

Missing ports mean the SFU is not ready to carry media.

---

### Step 5 - Verify Signalling Path

Internal path:

```bash
docker exec colab-backend sh -c "wget -qO- http://livekit:7534/"
```

External path:

```bash
curl -I https://collab.resulticks.com/livekit
```

Interpretation:

| Internal | External | Meaning                          |
| -------- | -------- | -------------------------------- |
| OK       | OK       | Signalling healthy               |
| FAIL     | FAIL     | LiveKit down                     |
| OK       | FAIL     | Nginx routing issue              |
| FAIL     | OK       | Internal Docker networking issue |

---

### Step 6 - Verify Token Secrets

Backend:

```bash
docker exec colab-backend printenv LIVEKIT_API_KEY LIVEKIT_API_SECRET
```

LiveKit:

```bash
docker exec colab-livekit printenv LIVEKIT_API_KEY LIVEKIT_API_SECRET
```

Values must match.

If they do not:

```text
Backend signs token
LiveKit rejects token
Every join fails
Media error everywhere
```

This is one of the most common causes of "everything broke after deployment."

---

### Step 7 - Check Restart History

```bash
docker inspect colab-livekit --format='{{.RestartCount}}'
docker inspect colab-backend --format='{{.RestartCount}}'
```

Large restart counts indicate:

```text
Crash loop
Startup failure
Resource issue
```

A container that restarted 20 times is not healthy just because it currently says "Up".

---

### Step 8 - Determine Whether LiveKit Restarted

If calls were previously working and suddenly stopped after deployment:

Check:

```bash
docker logs colab-livekit --since 30m
```

Look for:

```text
server starting
node registered
configuration loaded
```

around deployment time.

If present:

```text
LiveKit restarted
```

Expect:

```text
30-60 seconds warmup
ICE re-establishment
UDP rebinding
Node registration
```

during which users may see media failures.

---

### Step 9 - Validate Database State

```bash
docker exec colab-db mysql -ucolab -pcolab colab -N -e \
"SELECT COUNT(*) FROM schema_migrations;"
```

Compare against:

```bash
ls database/migrations/*.sql | wc -l
```

Mismatch means deployment may be running against a partially migrated schema.

---

### Step 10 - Final User-Level Validation

Never trust infrastructure checks alone.

Perform:

```text
Login
Send Message
Create Meeting
Join Meeting
Start 1:1 Call
Screen Share
```

on:

```text
LAN
VPN
Mobile Data
```

Only then declare deployment successful.

---

## K. Lessons Learned From The Global Call Outage

Observed sequence:

```text
Calls working globally
↓
Non-call related deployment
↓
Deployment completed
↓
Calls fail on every network
↓
Rollback performed
↓
Calls still fail
↓
Some time passes
↓
Calls recover automatically
```

Most probable explanation:

```text
Deployment disturbed LiveKit/media plane
↓
Backend and SFU temporarily out of sync
↓
Rollback triggered another restart cycle
↓
Services eventually converged
↓
Calls recovered
```

Important conclusion:

```text
This pattern does NOT strongly indicate an application bug.
This pattern DOES strongly indicate deployment orchestration,
service readiness, media-plane startup, or secret/config consistency issues.
```

Future deployments must always distinguish:

```text
Container Running
```

from

```text
Application Healthy
```

and

```text
Media Plane Ready
```

These are three different states.
