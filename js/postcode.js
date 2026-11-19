/* FindCNG Nigeria — postcode handling.
   Two systems (see NIPOST-POSTCODE-RESEARCH.md):
   - Old 6-digit area codes (e.g. 300001 Benin City GPO) — still in use.
   - New NDAPS 11-character building codes (e.g. FC 02 A09 DB 09, launched
     1 Oct 2026). Structure is validated offline; assignment is checked
     against the official NIPOST API through our serverless proxy.
     Coordinates are L5-restricted, so an NDAPS code alone can never be
     turned into a map point by this app — coordinates come from GPS or
     a map tap, and the postcode is the human-friendly label.
   Fallback chain (never hard-fail on location):
     exact 6-digit -> first-3-digits -> map pick / GPS.
   State codes: the full 37-code table below is NIPOST's own reference
   list, read from the live /v1/reference/states endpoint on 19 Nov 2026
   (ED = Edo confirmed there — no guessing). It is used only to NAME the
   state segment of a code the user typed; assignment is never decided
   offline.
   Sandbox reality (verified live 19 Nov 2026): the sandbox dataset holds
   only NIPOST's published sandbox codes (e.g. FC-01-A01-KP-27). The docs'
   format example FC 02 A09 DB 09 is not in the sandbox and returns
   valid:false — that is NIPOST's data, not a proxy bug.
*/
window.FINDCNG = window.FINDCNG || {};

FINDCNG.postcode = (function () {
  let table = null; // loaded from data/postcodes.json
  let tablePromise = null;
  let statusCache = null; // { configured, mode } from /api/postcode status

  // NDAPS: state(2 letters) LGA(2 digits) district(3 alnum) area(2 letters)
  // building(2-3 digits). Separators (space/hyphen) optional, any case.
  // Numeric segments run 01-99: 00 is never valid (NIPOST docs).
  const NDAPS_RE = /^([A-Z]{2})\s*-?\s*(\d{2})\s*-?\s*([A-Z0-9]{3})\s*-?\s*([A-Z]{2})\s*-?\s*(\d{2,3})$/i;
  const SIX_RE = /^\d{6}$/;

  // NIPOST reference states — all 36 states + FCT, from the live
  // /v1/reference/states endpoint (19 Nov 2026). Display names only.
  const STATE_NAMES = {
    AB: "Abia", AD: "Adamawa", AK: "Akwa Ibom", AN: "Anambra",
    BA: "Bauchi", BE: "Benue", BR: "Borno", BY: "Bayelsa",
    CR: "Cross River", DE: "Delta", EB: "Ebonyi", ED: "Edo",
    EK: "Ekiti", EN: "Enugu", FC: "Federal Capital Territory",
    GM: "Gombe", IM: "Imo", JI: "Jigawa", KD: "Kaduna",
    KE: "Kebbi", KG: "Kogi", KN: "Kano", KT: "Katsina",
    KW: "Kwara", LA: "Lagos", NA: "Nasarawa", NI: "Niger",
    OG: "Ogun", ON: "Ondo", OS: "Osun", OY: "Oyo",
    PL: "Plateau", RI: "Rivers", SK: "Sokoto", TA: "Taraba",
    YB: "Yobe", ZA: "Zamfara",
  };

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
      if (m[2] === "00" || m[5] === "00" || m[5] === "000") {
        return { kind: "ndaps", valid: false,
          reason: "The LGA and building numbers run from 01 to 99 — 00 is never valid in a digital postcode." };
      }
      const display = `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`;
      return {
        kind: "ndaps", valid: true, code: compact, display,
        segments: { state: m[1], lga: m[2], district: m[3], area: m[4], building: m[5] },
        stateName: STATE_NAMES[m[1]] || null,
        stateConfirmed: Object.prototype.hasOwnProperty.call(STATE_NAMES, m[1]),
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

  // --- NIPOST API via our serverless proxy (/api/postcode) ----------------
  // Every call returns the full envelope { configured, mode, result, error }
  // or null when our own server cannot be reached at all. Callers must
  // handle all three: result (answer), error (honest upstream failure),
  // null (offline / server unreachable) — never treat "no answer" as
  // "invalid code".
  async function callApi(body) {
    try {
      const r = await fetch("/api/postcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j || typeof j !== "object") return null;
      return j;
    } catch {
      return null;
    }
  }

  // How the proxy is configured (sandbox vs live) — no NIPOST call, so it
  // is cheap; cached per page load. The UI labels results with this.
  async function statusApi() {
    if (statusCache) return statusCache;
    const j = await callApi({ action: "status" });
    statusCache = j || { configured: false, mode: "unknown" };
    return statusCache;
  }

  // Validate a code at L1 (free tier: valid + LGA/state when returned).
  // level 2 (administrative address — the autofill demo) is honoured only
  // on sandbox keys; the server caps live keys at L1, so asking is safe.
  function lookupApi(code, level) {
    return callApi({ action: "lookup", code, level: level || 1 });
  }

  // Autocomplete suggestions from the official API (free tier).
  function searchApi(q) {
    return callApi({ action: "search", q });
  }

  // Postcodes near a point (free tier).
  function nearbyApi(lat, lng) {
    return callApi({ action: "nearby", lat, lng });
  }

  // The postcode at a point, if NIPOST has one within range (free tier).
  function reverseApi(lat, lng) {
    return callApi({ action: "reverse", lat, lng });
  }

  // The 37 state codes/names (free reference endpoint).
  function statesApi() {
    return callApi({ action: "states" });
  }

  // Plain-language explanation of a proxy error code, for the UI.
  // Every message says what happened and what the user can do — none of
  // them claims the code itself is invalid.
  function errorMessage(code) {
    switch (code) {
      case "timeout": return "NIPOST took too long to answer (over 8 seconds). Your code's structure is still checked above — try the online check again in a moment.";
      case "network_error": return "NIPOST could not be reached from our server. Your code's structure is still checked above — try again later.";
      case "nipost_unavailable": return "NIPOST's service is having trouble right now (their server returned an error). Your code's structure is still checked above — try again later.";
      case "rate_limited": return "Too many postcode checks in a short time — please wait a minute and try again.";
      case "invalid_key": return "The NIPOST key on our server is not being accepted. The team has been alerted by this message — the structure check above still works.";
      case "insufficient_credits": return "The NIPOST account is out of lookup credits, so the online check is paused. The structure check above still works.";
      case "not_granted": return "Our NIPOST access does not cover this lookup yet. The structure check above still works.";
      case "bad_request": return "NIPOST did not accept that request. Check the code and try again.";
      default: return "The online check is unavailable right now — the structure above is still valid; try again later.";
    }
  }

  return {
    parse, resolveSix, loadTable, STATE_NAMES,
    statusApi, lookupApi, searchApi, nearbyApi, reverseApi, statesApi,
    errorMessage,
  };
})();
