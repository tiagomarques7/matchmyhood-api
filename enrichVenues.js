/**
 * enrichVenues.js — MatchMyHood Supabase venue enricher
 * Reads all venues from Supabase, geocodes each via Google Places Find Place API,
 * then writes lat, lng, place_id, photo_url (and website if missing) back to Supabase.
 *
 * Usage:
 *   node enrichVenues.js                          # full run (~$5, all 209 venues)
 *   node enrichVenues.js --dry-run                # log only, no writes
 *   node enrichVenues.js --hood=chiado-lisbon     # one neighbourhood only
 *   node enrichVenues.js --dry-run --hood=chiado-lisbon
 *   node enrichVenues.js --photos                    # 2nd pass: fetch website+photo (~$3.50)
 *   node enrichVenues.js --photos --hood=chiado-lisbon
 *
 * Required env vars:
 *   SUPABASE_URL          https://bmhiyvrdklxswkfixydk.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key (not anon)
 *   GOOGLE_API_KEY        Places API key with Find Place + Photos enabled
 */

const https = require("https");

// ── CLI FLAGS ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const HOOD_ARG  = (args.find(a => a.startsWith("--hood=")) || "").replace("--hood=", "") || null;
const PHOTOS_MODE = args.includes("--photos"); // second pass: fetch website+photo for already-geocoded venues

if (DRY_RUN)     console.log("🟡 DRY RUN — no writes will happen");
if (HOOD_ARG)    console.log(`📍 Hood filter: ${HOOD_ARG}`);
if (PHOTOS_MODE) console.log("📷 PHOTOS MODE — fetching website + photo_url for geocoded venues");

// ── ENV ──────────────────────────────────────────────────────────────────────
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_API_KEY       = process.env.GOOGLE_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GOOGLE_API_KEY) {
  console.error("❌ Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_API_KEY");
  process.exit(1);
}

// ── SUPABASE REST HELPERS ────────────────────────────────────────────────────
// Use raw HTTPS to avoid requiring @supabase/supabase-js at runtime on DO
// (avoids npm install dependency issues in existing PM2 environment)

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const host = SUPABASE_URL.replace("https://", "");
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: host,
      path: `/rest/v1${path}`,
      method,
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": method === "PATCH" ? "return=representation" : "return=representation",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          if (res.statusCode >= 400) {
            reject(new Error(`Supabase ${method} ${path} → ${res.statusCode}: ${data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Supabase parse error: ${e.message} — ${data.slice(0, 200)}`));
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Fetch all venues (optionally filtered by neighbourhood slug)
async function fetchVenues(hoodSlug) {
  let path = "/venues?select=id,name,type,neighbourhood_id,website,photo_url,lat,lng,place_id,neighbourhoods(slug,name,city)";
  if (hoodSlug) {
    // Filter via join — use embedded filter syntax
    path = `/venues?select=id,name,type,neighbourhood_id,website,lat,lng,place_id,neighbourhoods!inner(slug,name,city)&neighbourhoods.slug=eq.${hoodSlug}`;
  }
  return await supabaseRequest("GET", path, null);
}

// Patch a single venue row
async function patchVenue(id, updates) {
  return await supabaseRequest("PATCH", `/venues?id=eq.${id}`, updates);
}

// ── GOOGLE PLACES FIND PLACE ─────────────────────────────────────────────────
// Old Places API — Find Place from text, returns place_id + geometry + photos + website
// Cost: ~$0.017/request (Find Place) + ~$0.007 if we fetch a photo URL

function findPlace(venueName, neighbourhood, city) {
  return new Promise((resolve) => {
    const input = encodeURIComponent(`${venueName}, ${neighbourhood}, ${city}`);
    const fields = "place_id,geometry,name";  // photos/website need Contact tier billing — skip for now
    const path = `/maps/api/place/findplacefromtext/json?input=${input}&inputtype=textquery&fields=${fields}&key=${GOOGLE_API_KEY}`;

    const req = https.request({
      hostname: "maps.googleapis.com",
      path,
      method: "GET",
      headers: { "Accept": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const candidates = parsed.candidates || [];
          if (candidates.length === 0) return resolve(null);
          const place = candidates[0];
          resolve({
            place_id:  place.place_id || null,
            lat:       place.geometry?.location?.lat || null,
            lng:       place.geometry?.location?.lng || null,
            website:   place.website || null,
            photoRef:  place.photos?.[0]?.photo_reference || null,
          });
        } catch (e) {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// Build a stable Google Photo URL from a photo_reference
// This URL redirects to the actual image — valid for embedding
function buildPhotoUrl(photoRef) {
  if (!photoRef) return null;
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${photoRef}&key=${GOOGLE_API_KEY}`;
}

// ── CLEAN VENUE NAME ────────────────────────────────────────────────────────
// Strip internal seed suffixes before passing to Google Places
function cleanName(name) {
  return name
    .replace(/\s+CH$/i, "")       // " CH" neighbourhood code
    .replace(/\s+main$/i, "")     // " main" suffix
    .trim();
}

// ── GOOGLE PLACE DETAILS — fetch website + photo for a known place_id ─────────
// Uses old Places API place/details endpoint
// Cost: ~$0.017/request (Basic + Contact fields)
function getPlaceDetails(place_id) {
  return new Promise((resolve) => {
    const fields = "website,photos";
    const path = `/maps/api/place/details/json?place_id=${place_id}&fields=${fields}&key=${GOOGLE_API_KEY}`;
    const req = https.request({
      hostname: "maps.googleapis.com",
      path,
      method: "GET",
      headers: { "Accept": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const result = parsed.result || {};
          resolve({
            website:  result.website || null,
            photoRef: result.photos?.[0]?.photo_reference || null,
          });
        } catch { resolve({ website: null, photoRef: null }); }
      });
      res.on("error", () => resolve({ website: null, photoRef: null }));
    });
    req.on("error", () => resolve({ website: null, photoRef: null }));
    req.end();
  });
}

// ── SLEEP ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n📦 Fetching venues from Supabase...");
  const venues = await fetchVenues(HOOD_ARG);

  if (!Array.isArray(venues)) {
    console.error("❌ Unexpected response from Supabase:", venues);
    process.exit(1);
  }

  console.log(`✅ ${venues.length} venues loaded${HOOD_ARG ? ` (hood: ${HOOD_ARG})` : ""}`);

  // PHOTOS MODE: fetch website + photo for venues that have place_id but missing website/photo
  if (PHOTOS_MODE) {
    const needsPhotos = venues.filter(v => v.place_id && (!v.website || !v.photo_url));
    const alreadyDone = venues.length - needsPhotos.length;
    console.log(`📷 ${needsPhotos.length} venues need website/photo, ${alreadyDone} already complete\n`);

    if (needsPhotos.length === 0) {
      console.log("✅ All venues already have website and photo. Nothing to do.");
      return;
    }

    let success = 0, fail = 0, skipped = 0;
    for (let i = 0; i < needsPhotos.length; i++) {
      const v = needsPhotos[i];
      const hood = v.neighbourhoods;
      const prefix = `[${i + 1}/${needsPhotos.length}]`;
      process.stdout.write(`${prefix} ${v.name} ... `);

      if (DRY_RUN) { console.log("→ [dry-run skip]"); skipped++; continue; }

      try {
        const details = await getPlaceDetails(v.place_id);
        const updates = {};
        if (!v.website && details.website)   updates.website   = details.website;
        if (!v.photo_url && details.photoRef) updates.photo_url = buildPhotoUrl(details.photoRef);

        if (Object.keys(updates).length === 0) {
          console.log("⏭  nothing new from Google");
          skipped++;
        } else {
          await patchVenue(v.id, updates);
          console.log(`✅${updates.website ? " 🌐" : ""}${updates.photo_url ? " 📷" : ""}`);
          success++;
        }
      } catch (err) {
        console.log(`💥 ${err.message}`);
        fail++;
      }
      await sleep(120);
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ Updated: ${success}  ❌ Failed: ${fail}  ⏭  Skipped: ${skipped}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    return;
  }

  // Filter: only process venues that are missing lat/lng OR missing place_id
  // (Skip already-enriched ones to allow re-runs safely)
  const needsEnrich = venues.filter(v => !v.lat || !v.lng || !v.place_id);
  const alreadyDone = venues.length - needsEnrich.length;

  console.log(`🔍 ${needsEnrich.length} need enrichment, ${alreadyDone} already have lat/lng+place_id\n`);

  if (needsEnrich.length === 0) {
    console.log("✅ All venues already enriched. Nothing to do.");
    return;
  }

  let success = 0, fail = 0, skipped = 0;

  for (let i = 0; i < needsEnrich.length; i++) {
    const v = needsEnrich[i];
    const hood = v.neighbourhoods;
    const hoodName = hood?.name || "Unknown";
    const city     = hood?.city || "Unknown";
    const prefix   = `[${i + 1}/${needsEnrich.length}]`;

    process.stdout.write(`${prefix} ${v.name} (${hoodName}, ${city}) ... `);

    if (DRY_RUN) {
      console.log("→ [dry-run skip]");
      skipped++;
      continue;
    }

    try {
      const searchName = cleanName(v.name);
      const result = await findPlace(searchName, hoodName, city);

      if (!result || !result.lat || !result.lng) {
        console.log("❌ not found");
        fail++;
      } else {
        const updates = {
          lat:      result.lat,
          lng:      result.lng,
          place_id: result.place_id,
          photo_url: buildPhotoUrl(result.photoRef),
        };

        // Only overwrite website if currently empty
        if (!v.website && result.website) {
          updates.website = result.website;
        }

        await patchVenue(v.id, updates);

        const hasPhoto   = !!result.photoRef;
        const hasWebsite = !!updates.website;
        console.log(`✅ ${result.lat.toFixed(4)}, ${result.lng.toFixed(4)}${hasPhoto ? " 📷" : ""}${hasWebsite ? " 🌐" : ""}`);
        success++;
      }
    } catch (err) {
      console.log(`💥 error: ${err.message}`);
      fail++;
    }

    // Throttle: 120ms between calls → max ~8/s (well under Google's 100/s limit)
    // Allows ~500 venues in ~1 minute
    await sleep(120);
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Enriched:  ${success}
❌ Not found: ${fail}
⏭  Skipped:   ${skipped} (dry-run)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${DRY_RUN ? "\n🟡 DRY RUN complete — re-run without --dry-run to apply." : ""}
`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
