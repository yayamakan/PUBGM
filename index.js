// vercel/index.js - /connect (and /v1) auth endpoint for patched libnative.so
//
// Request (from the app):
//   POST /connect
//   Content-Type: application/x-www-form-urlencoded
//   User-Agent: AbsoluteX/2.0
//   Body: game=PUBG&user_key=<KEY>&serial=<UUID>
//
// Response contract (matched to the REAL server's observed responses, e.g.):
//   error : {"status":false,"reason":"USER OR GAME NOT REGISTERED"}
//   ok    : {"status":true, "reason":"...", "rng":<unix seconds>, "data":"..."}
//
// nlohmann parsing rules the app applies:
//   - status : BOOLEAN (app checks it as true/false; a string here = type_error 302)
//   - error responses: status+reason ONLY. Do NOT send data:null or rng:null --
//     `type must be string, but is null` (302) is exactly what killed logins before.
//   - success responses: rng must be a NUMBER (app enforces now < rng + 30),
//     and any string field we include must be a real string.
//   - If the app reads data/rng unconditionally on the success path, keep them
//     present-and-typed there; on error it clearly does not need them (real
//     server proves it).

// ---------- storage ----------
// Device binding must survive between requests. If Upstash REST env vars are set
// (UPSTASH_URL, UPSTASH_TOKEN) we use that; otherwise in-memory per lambda
// instance (fine for testing, NOT for production).
const memory = new Map(); // key -> { devices: {serial: ts} }

async function kvGet(key) {
  if (process.env.UPSTASH_URL && process.env.UPSTASH_TOKEN) {
    const r = await fetch(`${process.env.UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${process.env.UPSTASH_TOKEN}` } });
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : null;
  }
  return memory.get(key) || null;
}

async function kvSet(key, val) {
  if (process.env.UPSTASH_URL && process.env.UPSTASH_TOKEN) {
    await fetch(`${process.env.UPSTASH_URL}/set/${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.UPSTASH_TOKEN}` },
        body: JSON.stringify(val),
      });
  } else {
    memory.set(key, val);
  }
}

// ---------- license database ----------
// Built-in license (edit here, or extend/override via LICENSES / VALID_KEYS env)
const BUILT_IN_LICENSES = {
  "Join@kembungjir": { expiry: "2099-12-31", max_devices: 9999 },
};

// Format A (rich):  LICENSES={"KEY1":{"expiry":"2027-01-31","max_devices":2},"KEY2":{}}
// Format B (simple): VALID_KEYS=KEY1,KEY2   (no expiry, 1 device each)
function loadLicenses() {
  const out = JSON.parse(JSON.stringify(BUILT_IN_LICENSES));
  if (process.env.LICENSES) {
    try {
      Object.assign(out, JSON.parse(process.env.LICENSES));
    } catch {
      console.error("LICENSES env is not valid JSON");
    }
  }
  if (process.env.VALID_KEYS) {
    for (const k of process.env.VALID_KEYS.split(",").map(s => s.trim())) {
      if (k && !out[k]) out[k] = {};
    }
  } else if (!process.env.LICENSES) {
    if (!out["DEMO-KEY-2026"]) out["DEMO-KEY-2026"] = {};
  }
  return out;
}

const MAX_DEVICES_DEFAULT = 1;

// ---- response builders matching the real server ----
function fail(res, reason) {
  // EXACTLY like the real server: no data, no rng. status is a real boolean.
  return res.json({ status: false, reason: String(reason ?? "") });
}

function ok(res, reason, data, rng) {
  // Success: boolean status + string fields + numeric rng.
  return res.json({
    status: true,
    reason: String(reason ?? "sukses"),
    data: String(data ?? ""),
    rng: Math.floor(Number(rng) || 0),
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const now = Date.now();
  const rng = Math.floor(now / 1000); // fresh unix seconds - the app enforces now < rng + 30

  // ---- 0. method check: app always POSTs; anything else is rejected ----
  if (req.method !== "POST") {
    return fail(res, "USER OR GAME NOT REGISTERED");
  }

  // Parse urlencoded body (Vercel may pre-parse it)
  let body = req.body || {};
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    try {
      body = Object.fromEntries(new URLSearchParams(body.toString()));
    } catch {
      body = {};
    }
  }

  const { game, user_key: userKey, serial } = body;

  // ---- 1. format check: required fields (same reason wording as real server) ----
  if (!game || !userKey || !serial || game !== "PUBG") {
    return fail(res, "USER OR GAME NOT REGISTERED");
  }

  const licenses = loadLicenses();
  const lic = licenses[userKey];

  // ---- 2. key registered? ----
  if (!lic) {
    return fail(res, "USER OR GAME NOT REGISTERED");
  }

  // ---- 3. expired? ----
  if (lic.expiry) {
    const exp = new Date(lic.expiry).getTime();
    if (Number.isFinite(exp) && now > exp) {
      return fail(res, "EXPIRED");
    }
  }

  // ---- 4. device slots ----
  const maxDevices = lic.max_devices ?? MAX_DEVICES_DEFAULT;
  const rec = (await kvGet(`dev:${userKey}`)) || { devices: {} };

  if (!rec.devices[serial]) {
    const used = Object.keys(rec.devices).length;
    if (used >= maxDevices) {
      return fail(res, "DEVICE LIMIT REACHED");
    }
    rec.devices[serial] = now;
    await kvSet(`dev:${userKey}`, rec);
  }

  // ---- 5. success ----
  const usedNow = Object.keys(rec.devices).length;
  const expiryMs = lic.expiry ? new Date(lic.expiry).getTime() : now + 30 * 24 * 3600 * 1000;
  return ok(res, "sukses",
    `key=${userKey};serial=${serial};expiry=${Math.floor(expiryMs / 1000)};devices=${usedNow}/${maxDevices}`,
    rng);
};
