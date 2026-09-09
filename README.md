# Vercel auth backend

## Deploy

```bash
cd PUBGM/vercel
npx vercel --prod
```

## License configuration

**Format A — rich (expiry + device limit per key):**

```bash
npx vercel env add LICENSES
# paste:
{"JESSE-001":{"expiry":"2027-01-31","max_devices":2},"TRIAL-01":{"expiry":"2026-12-31"}}
```

**Format B — simple (no expiry, 1 device each):**

```bash
npx vercel env add VALID_KEYS
# paste: KEY1,KEY2,KEY3
```

## Device slots ("device penuh")

Each key is bound to device `serial` values (UUID from android_id). Default limit
is **1 device per key** (override per key with `"max_devices": N`).

- New device + slots available -> bound, login OK
- New device + slots full -> `DEVICE LIMIT REACHED`

Storage: if `UPSTASH_URL` + `UPSTASH_TOKEN` env vars are set, device bindings are
stored in Upstash Redis (persistent, survives cold starts). Otherwise an in-memory
Map is used — fine for testing only, resets on every cold start.

```bash
npx vercel env add UPSTASH_URL
npx vercel env add UPSTASH_TOKEN
```

## Response contract (exact, from libnative.so disassembly)

Every response includes **`rng`** (unix seconds) — the app parses it from ALL
responses and enforces `now < rng + 30` (anti-replay). Missing/stale rng =
"RNG timestamp out of range - possible MITM!" even if status is fine.

| Case | method | status | reason |
|---|---|---|---|
| GET / selain POST | any ≠ POST | error | `Invalid Method` |
| field kurang / game salah | POST | error | `invalid format` |
| key tidak terdaftar | POST | error | `MEMBER OR KEY NOT REGISTERED` |
| key expired | POST | error | `EXPIRED` |
| device penuh | POST | error | `DEVICE LIMIT REACHED` |
| sukses | POST | `success` | `sukses` |

Success payload:

```json
{
  "status": "success",
  "rng": 1797000000,
  "reason": "sukses",
  "data": {
    "user_key": "JESSE-001",
    "serial": "...",
    "expiry": 1830192000000,
    "timestamp": 1797000000000,
    "devices_used": 1,
    "max_devices": 2
  }
}
```

Error payload shape: `{"status":"error","data":null,"rng":...,"reason":"..."}`

## Test

```bash
curl -X POST https://<app>.vercel.app/connect \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "User-Agent: AbsoluteX/2.0" \
  -d "game=PUBG&user_key=JESSE-001&serial=1234-5678"
```

Then point the app at it (from `PUBGM/`):

```bash
python3 patch_url.py libnative.so -o v1.so --url https://<app>.vercel.app/connect
python3 patch_ssl.py v1.so -o v2.so
python3 patch_canary.py v2.so -o v3.so
python3 patch_security.py v3.so -o libnative_final.so
```
