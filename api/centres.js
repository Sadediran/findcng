// GET /api/centres — approved centre submissions, merged into the app's
// station list at runtime, plus live verification counts for the stats.
// Only status = "approved" rows are ever returned as centres; pending and
// rejected submissions stay invisible to the public — but their COUNTS are
// published (counts cannot identify anyone):
//   counts.verified — approved submissions (the "Independently verified" badge)
//   counts.pending  — submissions awaiting review ("Pending verification")
// If Supabase is not configured the route answers { configured: false }.
import { json, sb, supabaseConfigured } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, centres: [], counts: { verified: 0, pending: 0 } });
  }
  try {
    const [rows, pendingRows] = await Promise.all([
      sb(
        `centre_submissions?select=id,centre_name,operator,address,state,phone,latitude,longitude,verification_date` +
        `&status=eq.approved&order=verification_date.desc&limit=500`
      ),
      sb(`centre_submissions?select=id&status=eq.pending&limit=1000`),
    ]);
    const centres = (rows || []).map((r) => ({
      id: "SUB-" + String(r.id).slice(0, 8),
      name: r.centre_name,
      operator: r.operator,
      address: r.address,
      city: "",
      state: r.state,
      postcode: null,
      latitude: r.latitude,
      longitude: r.longitude,
      phone: r.phone,
      verification_date: r.verification_date,
    }));
    return json(res, 200, {
      configured: true,
      centres,
      counts: { verified: centres.length, pending: (pendingRows || []).length },
    });
  } catch (e) {
    return json(res, 500, { configured: true, centres: [], counts: { verified: 0, pending: 0 },
      error: String(e.message || e).slice(0, 160) });
  }
}
