/* FindCNG Nigeria — editable content & prices.
   HOW TO UPDATE PRICES: change the numbers below, then redeploy.
   Sources are in CNG-PUBLIC-SENTIMENT.md (prices as reported Sep–Nov 2026).
   Always re-check prices before a demo — they move. */
window.FINDCNG = window.FINDCNG || {};

FINDCNG.PRICES = {
  // CNG price after subsidy support was withdrawn, Sep 2025 (Punch, Pulse).
  cngPerScmCar: 380,        // ₦/SCM — cars and buses
  cngPerScmTruck: 450,      // ₦/SCM — trucks
  // Petrol: reported range ₦1,330–₦1,405/litre (Nov 2026). Default is the midpoint.
  petrolPerLitre: 1370,
  petrolRange: "₦1,330–₦1,405",
  priceDate: "November 2026",
  priceNote: "CNG ₦380/SCM (cars/buses) and ₦450/SCM (trucks) after subsidy support was withdrawn in September 2025. Petrol ₦1,330–₦1,405/litre as reported November 2026. Prices move — check before you rely on them.",
};

// Typical fuel use — labelled estimates the user can change in the calculator.
FINDCNG.VEHICLES = {
  car:   { label: "Car",   kmPerLitre: 10, cngPrice: 380, convLow: 350000, convHigh: 600000, convLabel: "Official range for cars: ₦350,000–₦600,000 (Pi-CNG). Market prices run ₦650,000–₦2,500,000." },
  keke:  { label: "Keke / tricycle", kmPerLitre: 20, cngPrice: 380, convLow: 180000, convHigh: 280000, convLabel: "Official range for keke: ₦180,000–₦280,000 (Pi-CNG)." },
  bus:   { label: "Bus / van", kmPerLitre: 7, cngPrice: 380, convLow: 450000, convHigh: 800000, convLabel: "Official range for buses/vans: ₦450,000–₦800,000 (Pi-CNG)." },
  truck: { label: "Truck", kmPerLitre: 4, cngPrice: 450, convLow: 650000, convHigh: 2500000, convLabel: "No official truck range published — market range ₦650,000–₦2,500,000." },
};

// 1 SCM of CNG holds roughly the energy of ~1.1 litres of petrol.
// Labelled as an estimate in the calculator; the user can adjust km/litre.
FINDCNG.SCM_PER_LITRE_EQUIV = 1.1;

FINDCNG.STATUS = {
  available:   { label: "Gas available", icon: "●", hint: "There is gas now" },
  low:         { label: "Low / long queue", icon: "●", hint: "Gas is low, or the queue is long" },
  finished:    { label: "Gas finished", icon: "●", hint: "No gas at the moment" },
  closed:      { label: "Closed", icon: "●", hint: "Station closed" },
  unconfirmed: { label: "Unconfirmed", icon: "●", hint: "No report in the last 2 hours" },
};

// Reports older than this stop counting (2 hours, per the blueprint).
FINDCNG.REPORT_TTL_MS = 2 * 60 * 60 * 1000;

FINDCNG.TYPE_LABEL = {
  refuelling: "Refuelling station",
  conversion: "Conversion centre",
  both: "Refuelling + conversion",
};

FINDCNG.CONFIDENCE_LABEL = {
  verified: "Verified listing",
  "single-source": "Single source — needs a second check",
  "stale-2024-list": "From a 2024 list — needs re-checking",
};

FINDCNG.NIGERIA_CENTRE = [9.08, 8.68]; // default map centre (Nigeria)
FINDCNG.NIGERIA_ZOOM = 6;

// Pi-CNG register dates shown on badges (from the extraction, Nov 2026).
FINDCNG.REGISTER_DATES = {
  centres: "18 Nov 2026",   // accredited centres register checked
  refuel: "15 Oct 2026",    // refuelling stations register updated
};

// Typical-fill estimate shown on station cards (image 22: full-fill cost).
// A 60-litre cylinder holds about 12 SCM at 200 bar — physics, not a price
// survey. Always labelled as an estimate from the NATIONAL price, never as
// that station's price. Never shown as a station price.
FINDCNG.FILL = {
  cylinderLitres: 60,
  scm: 12,
  note: "Typical fill (60-litre cylinder, about 12 SCM)",
};

// Pidgin (PCM) versions of the safety hub — swapped in by the EN/PCM toggle.
// Same facts, same attributions, plain Nigerian Pidgin.
FINDCNG.SAFETY_PCM = {
  lead: "<b>Di short answer: certified CNG system dey safe. Na fake cylinder and quack installer be di danger.</b><br><br>" +
    "If dem design am well, certify am, and professional install am, CNG system dey follow strict safety standard and inspection. Unauthorised cylinder, uncertified conversion kit and bad installation dey increase risk of serious accident.<br><br>" +
    "For all di incidents wey dem don investigate so far, each one na because of uncertified equipment or unqualified installation — fake or welded cylinder, cooking-gas cylinder, air-conditioner cylinder, or overfilling.",
  causes:
    "<p><b>1. Fake or welded cylinder.</b> Local welder go fabricate cylinder from scrap metal. Dem never design am or test am to hold gas under high pressure. Na dis one cause di Benin City explosion for October 2024 — 3 people wound badly, dem cut one person leg. Dem arrest di welder. <span class=\"small\">(Source: Standards Organisation of Nigeria; Punch / BusinessDay, Oct 2024.)</span></p>" +
    "<p><b>2. Di wrong cylinder entirely.</b> Dem don put LPG cooking-gas cylinder and even air-conditioner cylinder as CNG cylinder. Dem no build dem for CNG pressure. One car spoil for September 2026 after dem put AC cylinder with AC pipe. <span class=\"small\">(Source: Facebook video, Senior Advocate of Truth, Sep 2026.)</span></p>" +
    "<p><b>3. Overfilling.</b> To fill pass di cylinder safe limit. Kaduna police first findings link di April 2026 Kaduna bus explosion to overfilling — police spokesman Mansir Hassan talk for 5 April 2026 say di bus “explode because dem overfill di gas tank”, and Kaduna State Government talk say na “small explosion wey dem trace to technical fault wey link to overfilling”. Di operator, Silver Luxury Travel, no gree; Governor Uba Sani order multi-agency probe; and dem never publish final finding as of 18 November 2026. Note: police talk say na LNG bus; press talk say na CNG. <span class=\"small\">(Sources: Kaduna police statement, 5 Apr 2026; Kaduna State Government; Punch, 5 Apr 2026.)</span></p>" +
    "<p style=\"margin-bottom:0\"><b>4. Quack installer.</b> Roadside mechanic wey no get accreditation, dey fit kit for engine wey no dey good condition. Di Minister of State for Petroleum Resources (Gas) don blame unverified, uncertified conversions — many na roadside technician do am — directly for di wave of explosions. <span class=\"small\">(Source: Minister Ekperikpe Ekpo, reported 2026.)</span></p>",
  myths:
    "<div class=\"card myth\"><p style=\"margin:0\"><b>Myth:</b> “CNG car na time bomb.”<br><b>Fact:</b> For all di incidents wey dem don investigate so far, each one na because of uncertified equipment or unqualified installation — fake cylinder or quack fitting. Certified system wey accredited centre install, dem build am and inspect am with strict standard.</p></div>" +
    "<div class=\"card fact\"><p style=\"margin:0\"><b>Myth:</b> “E go blow for heat.”<br><b>Fact:</b> CNG dey catch fire for about 700°C — petrol na about 455°C. CNG need more heat well-well before e catch fire. And CNG light pass air: if e leak, e go rise go up and scatter, e no go pool for ground like petrol.</p></div>" +
    "<div class=\"card fact\"><p style=\"margin:0\"><b>Myth:</b> “Any cylinder go do.”<br><b>Fact:</b> Na only certified automotive CNG cylinder — multi-layer steel or composite, wey dem don pressure-test. Cooking-gas cylinder or AC cylinder no be CNG cylinder, no matter wetin anybody tell you.</p></div>" +
    "<div class=\"card fact\"><p style=\"margin:0\"><b>Myth:</b> “Conversion na one-time job.”<br><b>Fact:</b> Dem must test cylinder every 3 years. Ask your centre when your cylinder test go due.</p></div>",
  checklist:
    "<p>✅ Convert only for <b>accredited centre</b> — check am for Centres tab first.</p>" +
    "<p>✅ Ask to see di <b>accreditation certificate</b> and di cylinder certification markings.</p>" +
    "<p>✅ Never accept <b>welded, second-hand or cooking-gas cylinder</b>.</p>" +
    "<p>✅ Make sure your <b>engine dey good condition</b> before you convert — CNG dey show engine problem wey don dey there.</p>" +
    "<p>✅ Test di <b>cylinder every 3 years</b>.</p>" +
    "<p style=\"margin-bottom:0\">⚠️ If you smell gas or hear hissing: switch off, come out of di vehicle, waka go far, and go accredited centre. <b>Never try fix gas system yourself.</b></p>",
};
