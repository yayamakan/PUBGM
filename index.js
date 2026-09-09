// vercel/index.js - /connect auth endpoint for patched libnative.so
//
// Request (from the app):
//   POST /connect
//   Content-Type: application/x-www-form-urlencoded
//   User-Agent: AbsoluteX/2.0
//   Body: game=PUBG&user_key=<KEY>&serial=<UUID>
//
// Response contract (reverse-engineered from libnative.so):
//   { status, data, rng, reason }
//   - rng      : unix seconds, MUST be fresh (app checks now < rng + 30,
//                else "RNG timestamp out of range - possible MITM!") - required
//                in EVERY response, including errors.
//   - status   : compared against the app's hardcoded success string
//   - reason   : shown to the user / logs
//
// Rules implemented here:
//   GET / other methods   -> "Invalid Method"
//   missing fields        -> "invalid format"
//   key not registered    -> "MEMBER OR KEY NOT REGISTERED"
//   key expired           -> "EXPIRED"
//   device slots full     -> "DEVICE LIMIT REACHED"
//   success               -> "sukses" + data payload

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
// HARDCODED LICENSE DATABASE
const LICENSES = {
  "Join@kembungjir": {
    expiry: "2029-12-31",
    max_devices: 999999999
  },
  "DEMO-KEY-2026": {
    expiry: "2027-12-31",
    max_devices: 1
  }
};

const MAX_DEVICES_DEFAULT = 1;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const now = Date.now();
  const rng = Math.floor(now / 1000); // fresh unix seconds - the app enforces now < rng + 30

  // ---- 0. method check: app always POSTs; anything else is rejected ----
  if (req.method !== "POST") {
    return res.json({ status: "error", data: null, rng, reason: "Invalid Method" });
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

  // ---- 1. format check: required fields ----
  if (!game || !userKey || !serial || game !== "PUBG") {
    return res.json({ status: "error", data: null, rng, reason: "invalid format" });
  }

  const lic = LICENSES[userKey];

  // ---- 2. key registered? ----
  if (!lic) {
    return res.json({ status: "error", data: null, rng, reason: "MEMBER OR KEY NOT REGISTERED" });
  }

  // ---- 3. expired? ----
  if (lic.expiry) {
    const exp = new Date(lic.expiry).getTime();
    if (Number.isFinite(exp) && now > exp) {
      return res.json({
        status: "error",
        data: { user_key: userKey, expired_at: lic.expiry },
        rng,
        reason: "EXPIRED",
      });
    }
  }

  // ---- 4. device slots ----
  const maxDevices = lic.max_devices ?? MAX_DEVICES_DEFAULT;
  const rec = (await kvGet(`dev:${userKey}`)) || { devices: {} };

  if (!rec.devices[serial]) {
    const used = Object.keys(rec.devices).length;
    if (used >= maxDevices) {
      return res.json({
        status: "error",
        data: { user_key: userKey, devices_used: used, max_devices: maxDevices },
        rng,
        reason: "DEVICE LIMIT REACHED",
      });
    }
    rec.devices[serial] = now;
    await kvSet(`dev:${userKey}`, rec);
  }

  // ---- 5. success ----
  return res.json({
    status: "success",
    rng,
    reason: "sukses",
    data: {
      user_key: userKey,
      serial,
      expiry: lic.expiry || now + 30 * 24 * 3600 * 1000,
      timestamp: now,
      devices_used: Object.keys(rec.devices).length,
      max_devices: maxDevices,
    },
  });
};