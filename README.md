# Vercel auth backend

## Deploy

```bash
cd PUBGM/vercel
npx vercel --prod
```

## License configuration

**Built-in key (hardcoded in `index.js`):**

| Key | Expiry | Devices |
|---|---|---|
| `Join@kembungjir` | `2099-12-31` | 1 |

Built-in keys are always available; `LICENSES` env **merges on top**, `VALID_KEYS`
appends extra keys.

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

## Response contract (matched to the REAL server's observed responses)

**Error** (wrong method, bad fields, unknown key, expired, device limit) — EXACTLY
like the real server, no other fields:

```json
{"status": false, "reason": "USER OR GAME NOT REGISTERED"}
```

**Success:**

```json
{"status": true, "reason": "sukses", "data": "key=...;serial=...;expiry=...;devices=1/1", "rng": 1797000000}
```

**HARD RULES (nlohmann parsing in libnative.so):**

- `status` : **BOOLEAN** (`true`/`false`) — a string here = type_error 302
- error responses: `status` + `reason` ONLY. Never add `data`/`rng` (and NEVER
  `null` values — `[json.exception.type_error.302] type must be string, but is null`
  is what broke logins with the old backend)
- success: `data`/`reason` are strings, `rng` is a NUMBER (app enforces
  `now < rng + 30` anti-replay)

| Case | status | reason |
|---|---|---|
| GET / selain POST | `false` | `USER OR GAME NOT REGISTERED` |
| field kurang / game salah | `false` | `USER OR GAME NOT REGISTERED` |
| key tidak terdaftar | `false` | `USER OR GAME NOT REGISTERED` |
| key expired | `false` | `EXPIRED` |
| device penuh | `false` | `DEVICE LIMIT REACHED` |
| sukses | `true` | `sukses` |

## Routes

`/connect` and `/v1` both map to the same handler (see `vercel.json`) — the patched
libnative.so in this repo points at `https://pubgmx.vercel.app/v1`.

## Test

```bash
node test_contract.js   # local contract smoke test (no server needed)
curl -X POST https://<app>.vercel.app/v1 \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "User-Agent: AbsoluteX/2.0" \
  -d "game=PUBG&user_key=JESSE-001&serial=1234-5678"
```

Then point the app at it (from `PUBGM/`):

```bash
python3 patch_url.py libnative.so -o libnative_patch.so --url https://<app>.vercel.app/v1
python3 patch_libnative.py libnative_patch.so -o libnative_patch.so --frag
python3 patch_ssl.py libnative_patch.so -o libnative_patch.so
python3 patch_canary.py libnative_patch.so -o libnative_patch.so
python3 patch_security.py libnative_patch.so -o libnative_patch.so
```
