/* FindCNG Nigeria — postcode handling.
   Two systems (see NIPOST-POSTCODE-RESEARCH.md):
   - Old 6-digit area codes (e.g. 300001 Benin City GPO) — still in use.
   - New NDAPS 11-character building codes (e.g. FC 02 A09 DB 09, launched
     1 Oct 2026). Validated on structure only; coordinates are L5-restricted
     so an NDAPS code alone can never be turned into a map point by this app.
   Fallback chain (never hard-fail on location):
     exact 6-digit -> first-3-digits -> map pick / GPS.
   Edo's NDAPS 2-letter state code is NOT confirmed in any public source —
   this module never guesses it and never rejects a code for its state part.
*/
window.FINDCNG = window.FINDCNG || {};

FINDCNG.postcode = (function () {
  let table = null; // loaded from data/postcodes.json
  let tablePromise = null;

  // NDAPS: state(2 letters) LGA(2 digits) district(3 alnum) area(2 letters)
  // building(2-3 digits). Separators (space/hyphen) optional, any case.
  const NDAPS_RE = /^([A-Z]{2})\s*-?\s*(\d{2})\s*-?\s*([A-Z0-9]{3})\s*-?\s*([A-Z]{2})\s*-?\s*(\d{2,3})$/i;
  const SIX_RE = /^\d{6}$/;

  // State codes confirmed in public sources (Oct 2026). Used only to say
  // "this state code is on the confirmed list" — never to reject others.
  const CONFIRMED_STATES = new Set(["AB","AK","BA","EB","EK","EN","FC","JI","KN","LA","NI","OG"]);

  function loadTable() {
    if (!tablePromise) {
      tablePromise = fetch("data/postcodes.json")
        .then((r) => r.json())
        .then((j) => { table = j; return j; })
        .catch(() => { table = { exact: {}, prefix3: {} }; return table; });
    }
    return tablePromise;
  }

  // Parse user input. Returns { kind, valid, ... } — never throws.
  function parse(raw) {
    const s = String(raw || "").trim().toUpperCase().replace(/[\s-]+/g, " ").trim();
    if (!s) return { kind: null, valid: false, reason: "empty" };
    const compact = s.replace(/[\s-]/g, "");
    if (SIX_RE.test(compact)) {
      return { kind: "six", valid: true, code: compact, display: compact };
    }
    const m = NDAPS_RE.exec(s.replace(/[\s-]/g, " "));
    if (m) {
      const display = `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`;
      return {
        kind: "ndaps", valid: true, code: compact, display,
        segments: { state: m[1], lga: m[2], district: m[3], area: m[4], building: m[5] },
        stateConfirmed: CONFIRMED_STATES.has(m[1]),
      };
    }
    if (/^\d+$/.test(compact)) {
      return { kind: "six", valid: false, reason: "A 6-digit postcode needs exactly 6 numbers." };
    }
    return { kind: null, valid: false,
      reason: "That does not look like a postcode. Use a 6-digit code (e.g. 300001) or an 11-character code (e.g. FC 02 A09 DB 09)." };
  }

  // Resolve a 6-digit code through the fallback chain.
  // Returns { lat, lng, place, approx, level } or null.
  async function resolveSix(code) {
    await loadTable();
    if (table.exact[code]) return { ...table.exact[code], level: "exact" };
    const p3 = code.slice(0, 3);
    if (table.prefix3[p3]) return { ...table.prefix3[p3], level: "district" };
    return null;
  }

  // Ask the official NIPOST API (via our serverless proxy) to validate a
  // code at L1 (free tier: valid + LGA). Returns null when the API/key is
  // unavailable — the caller must fall back to local handling.
  async function lookupApi(code) {
    try {
      const r = await fetch("/api/postcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "lookup", code }),
      });
      const j = await r.json();
      if (!j || !j.configured) return null;
      return j.result || null;
    } catch {
      return null;
    }
  }

  // Autocomplete suggestions from the official API (free tier).
  async function searchApi(q) {
    try {
      const r = await fetch("/api/postcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "search", q }),
      });
      const j = await r.json();
      if (!j || !j.configured) return null;
      return j.result || null;
    } catch {
      return null;
    }
  }

  return { parse, resolveSix, lookupApi, searchApi, loadTable };
})();
