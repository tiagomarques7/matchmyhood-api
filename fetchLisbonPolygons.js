/**
 * fetchLisbonPolygons.js
 * Queries Overpass API for real OSM boundary polygons for each Lisbon neighbourhood,
 * then generates SQL to update the Supabase neighbourhoods geom column.
 *
 * Usage:
 *   node fetchLisbonPolygons.js
 *
 * Output:
 *   lisbon_polygons_osm.sql  — paste into Supabase SQL editor
 *   lisbon_polygons_debug.json — raw OSM data for inspection
 */

const https = require("https");
const fs    = require("fs");

// ── NEIGHBOURHOOD → OSM QUERY ────────────────────────────────────────────────
// Each entry maps our Supabase name to the best OSM search strategy.
// We try relation boundaries first (most accurate), then area fallback.
const HOODS = [
  { name: "Chiado",                  osm: "Chiado, Lisboa" },
  { name: "Bairro Alto",             osm: "Bairro Alto, Lisboa" },
  { name: "Príncipe Real",           osm: "Príncipe Real, Lisboa" },
  { name: "Alfama",                  osm: "Alfama, Lisboa" },
  { name: "Mouraria",                osm: "Mouraria, Lisboa" },
  { name: "Intendente / Arroios",    osm: "Intendente, Lisboa" },
  { name: "Estrela",                 osm: "Estrela, Lisboa" },
  { name: "Campo de Ourique",        osm: "Campo de Ourique, Lisboa" },
  { name: "Alcântara / LX Factory",  osm: "Alcântara, Lisboa" },
  { name: "Belém",                   osm: "Belém, Lisboa" },
  { name: "Avenidas Novas",          osm: "Avenidas Novas, Lisboa" },
  { name: "Parque das Nações",       osm: "Parque das Nações, Lisboa" },
];

// ── HTTP HELPERS ─────────────────────────────────────────────────────────────
function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: "GET",
      headers: { "User-Agent": "MatchMyHood/1.0 (matchmyhood.com)", "Accept": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 100)}`)); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── NOMINATIM: get OSM relation ID for a neighbourhood name ──────────────────
async function findOsmId(query) {
  try {
    const path = `/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
    const results = await httpGet("nominatim.openstreetmap.org", path);

    // Prefer results with type neighbourhood, quarter, suburb, or city_district
    const preferred = results.filter(r =>
      ["neighbourhood","quarter","suburb","city_district","residential"].includes(r.type) ||
      ["neighbourhood","quarter","suburb","city_district"].includes(r.class)
    );

    const best = preferred[0] || results[0];
    if (!best) return null;

    console.log(`  Nominatim: "${query}" → ${best.display_name.slice(0,60)} (${best.osm_type}/${best.osm_id}, type:${best.type})`);
    return { osm_type: best.osm_type, osm_id: best.osm_id, display_name: best.display_name };
  } catch (e) {
    console.error(`  Nominatim error for "${query}":`, e.message);
    return null;
  }
}

// ── NOMINATIM: fetch full polygon for an OSM ID ──────────────────────────────
async function fetchPolygon(osm_type, osm_id) {
  try {
    const typeChar = osm_type === "relation" ? "R" : osm_type === "way" ? "W" : "N";
    const path = `/lookup?osm_ids=${typeChar}${osm_id}&format=json&polygon_geojson=1`;
    const results = await httpGet("nominatim.openstreetmap.org", path);

    if (!results || results.length === 0) return null;
    const geojson = results[0].geojson;
    if (!geojson) return null;
    return geojson;
  } catch (e) {
    console.error(`  Polygon fetch error:`, e.message);
    return null;
  }
}

// ── GEOJSON → WKT POLYGON ────────────────────────────────────────────────────
// Handles Polygon and MultiPolygon, takes the largest ring
function geojsonToWkt(geojson) {
  let coords;

  if (geojson.type === "Polygon") {
    coords = geojson.coordinates[0]; // outer ring
  } else if (geojson.type === "MultiPolygon") {
    // Take the largest polygon by number of points
    let largest = [];
    for (const poly of geojson.coordinates) {
      if (poly[0].length > largest.length) largest = poly[0];
    }
    coords = largest;
  } else {
    return null;
  }

  if (!coords || coords.length < 3) return null;

  // Simplify if too many points (keep every Nth point for very detailed boundaries)
  // PostGIS handles up to ~10k points fine, but simplify if over 2000 for performance
  let ring = coords;
  if (ring.length > 2000) {
    const step = Math.ceil(ring.length / 1000);
    ring = ring.filter((_, i) => i % step === 0 || i === ring.length - 1);
    console.log(`  Simplified: ${coords.length} → ${ring.length} points`);
  }

  // Ensure closed ring (first = last)
  if (ring[0][0] !== ring[ring.length-1][0] || ring[0][1] !== ring[ring.length-1][1]) {
    ring = [...ring, ring[0]];
  }

  const pointStr = ring.map(([lng, lat]) => `${lng} ${lat}`).join(", ");
  return `POLYGON((${pointStr}))`;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🗺  Fetching Lisbon neighbourhood polygons from OpenStreetMap\n");

  const results = [];
  const sqlLines = [
    "-- ============================================================",
    "-- Lisbon Neighbourhood Polygons — OSM-sourced v2",
    `-- Generated ${new Date().toISOString()}`,
    "-- Paste into Supabase SQL editor",
    "-- ============================================================",
    "",
  ];

  for (const hood of HOODS) {
    console.log(`\n[${hood.name}]`);
    await sleep(1200); // Nominatim rate limit: 1 req/sec

    // Step 1: find OSM ID
    const osmResult = await findOsmId(hood.osm);
    if (!osmResult) {
      console.log(`  ❌ Not found in Nominatim`);
      results.push({ name: hood.name, status: "not_found" });
      sqlLines.push(`-- ❌ ${hood.name}: not found in OSM\n`);
      continue;
    }

    await sleep(1200);

    // Step 2: fetch polygon
    const geojson = await fetchPolygon(osmResult.osm_type, osmResult.osm_id);
    if (!geojson) {
      console.log(`  ❌ No polygon geometry`);
      results.push({ name: hood.name, status: "no_polygon", osm: osmResult });
      sqlLines.push(`-- ❌ ${hood.name}: OSM result found but no polygon geometry\n`);
      continue;
    }

    // Step 3: convert to WKT
    const wkt = geojsonToWkt(geojson);
    if (!wkt) {
      console.log(`  ❌ Could not convert to WKT (type: ${geojson.type})`);
      results.push({ name: hood.name, status: "wkt_failed", geojson });
      sqlLines.push(`-- ❌ ${hood.name}: geometry type ${geojson.type} — could not convert\n`);
      continue;
    }

    console.log(`  ✅ Polygon ready (${geojson.type})`);
    results.push({ name: hood.name, status: "ok", osm: osmResult, geojson });

    // Escape single quotes in WKT (shouldn't happen but safety)
    const safeWkt = wkt.replace(/'/g, "''");
    const safeName = hood.name.replace(/'/g, "''");

    sqlLines.push(`-- ${hood.name} (OSM: ${osmResult.osm_type}/${osmResult.osm_id})`);
    sqlLines.push(`UPDATE neighbourhoods SET geom = ST_SetSRID(ST_GeomFromText('${safeWkt}'), 4326)`);
    sqlLines.push(`WHERE name = '${safeName}' AND city = 'Lisbon';`);
    sqlLines.push("");
  }

  // Verification query
  sqlLines.push("-- ============================================================");
  sqlLines.push("-- Verify all 12 + show area");
  sqlLines.push("-- ============================================================");
  sqlLines.push("SELECT name, city,");
  sqlLines.push("  CASE WHEN geom IS NOT NULL THEN '✅ polygon set' ELSE '❌ missing' END AS status,");
  sqlLines.push("  ROUND(ST_Area(geom::geography) / 1000000, 3) AS area_km2");
  sqlLines.push("FROM neighbourhoods WHERE city = 'Lisbon' ORDER BY name;");

  // Write SQL file
  const sqlOutput = sqlLines.join("\n");
  fs.writeFileSync("/app/lisbon_polygons_osm.sql", sqlOutput, "utf8");
  console.log(`\n✅ SQL written to /app/lisbon_polygons_osm.sql`);

  // Write debug JSON
  fs.writeFileSync("/app/lisbon_polygons_debug.json", JSON.stringify(results, null, 2), "utf8");
  console.log(`✅ Debug JSON written to /app/lisbon_polygons_debug.json`);

  // Summary
  const ok      = results.filter(r => r.status === "ok").length;
  const failed  = results.filter(r => r.status !== "ok").length;
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Polygons fetched: ${ok}/${HOODS.length}`);
  if (failed > 0) console.log(`❌ Failed: ${failed} — check lisbon_polygons_debug.json`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
