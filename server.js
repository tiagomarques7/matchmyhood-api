const https = require("https");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const FOURSQUARE_KEY = process.env.FOURSQUARE_KEY || "244GKZ3SYN0QA4CMYR4VXURO3PLM00MUWHAXLJUV04UE05T1";

// ── CLAUDE API ──────────────────────────────────────────────────────────────
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 6000,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(requestBody),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error("Claude API error: " + res.statusCode + " " + data));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content[0].text.trim());
        } catch (e) {
          reject(new Error("Failed to parse Claude response"));
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.write(requestBody);
    req.end();
  });
}

// ── FOURSQUARE API ──────────────────────────────────────────────────────────
function searchFoursquare(lat, lng, query, categories, limit = 3) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      ll: `${lat},${lng}`,
      query: query,
      categories: categories,
      radius: 600,
      limit: limit,
      sort: "RELEVANCE",
      fields: "name,location,rating,categories"
    });

    const req = https.request({
      hostname: "api.foursquare.com",
      path: `/v3/places/search?${params.toString()}`,
      method: "GET",
      headers: {
        "Authorization": FOURSQUARE_KEY,
        "Accept": "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.results || []);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    });

    req.on("error", () => resolve([]));
    req.end();
  });
}

// ── OVERPASS API — single batched query per neighbourhood ──────────────────
// Fetches ALL amenity types + transit in ONE request to avoid rate limiting
function fetchAllAmenities(lat, lng, city) {
  const tags = CITY_TAGS[city] || DEFAULT_TAGS;

  return new Promise((resolve) => {
    const empty = { pharmacies: 0, supermarkets: 0, parks: 0, gyms: 0, intlSchools: 0, museums: 0, restaurants: 0, bars: 0, nearestMetro: [] };

    // Build union of all nwr (node/way/relation) queries
    const parts = [
      `nwr["amenity"="pharmacy"](around:700,${lat},${lng});`,
      // Restaurants & bars for VISIT mode counts
      `nwr["amenity"="restaurant"](around:600,${lat},${lng});`,
      `nwr["amenity"="cafe"](around:600,${lat},${lng});`,
      `nwr["amenity"="bar"](around:600,${lat},${lng});`,
      `nwr["amenity"="pub"](around:600,${lat},${lng});`,
      `nwr["amenity"="wine_bar"](around:600,${lat},${lng});`,
    ];
    for (const [k, v] of (tags.supermarkets || []))
      parts.push(`nwr["${k}"="${v}"](around:700,${lat},${lng});`);
    for (const [k, v] of (tags.gyms || []))
      parts.push(`nwr["${k}"="${v}"](around:700,${lat},${lng});`);
    for (const [k, v] of (tags.parks || []))
      parts.push(`nwr["${k}"="${v}"](around:900,${lat},${lng});`);
    for (const [k, v] of (tags.schools || []))
      parts.push(`nwr["${k}"="${v}"](around:2000,${lat},${lng});`);
    for (const [k, v] of (tags.museums || []))
      parts.push(`nwr["${k}"="${v}"](around:1500,${lat},${lng});`);
    // Transit: subway_entrance and tram_stop are nodes; stations can be way/relation
    parts.push(
      `nwr["railway"="station"](around:800,${lat},${lng});`,
      `node["railway"="subway_entrance"](around:800,${lat},${lng});`,
      `node["railway"="tram_stop"](around:800,${lat},${lng});`,
      `node["railway"="halt"](around:800,${lat},${lng});`,
      `nwr["station"="subway"](around:800,${lat},${lng});`,
      `node["public_transport"="stop_position"]["tram"="yes"](around:800,${lat},${lng});`,
      `node["public_transport"="stop_position"]["subway"="yes"](around:800,${lat},${lng});`
    );

    const query = `[out:json][timeout:45];\n(\n${parts.join('\n')}\n);\nout center tags;`;
    const body = `data=${encodeURIComponent(query)}`;

    const req = https.request({
      hostname: "overpass-api.de",
      path: "/api/interpreter",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          // Overpass returns HTML when rate-limited — detect and bail out cleanly
          if (data.trimStart().startsWith("<")) {
            console.error("Overpass rate-limited (HTML response) — returning empty");
            resolve(empty);
            return;
          }
          const parsed = JSON.parse(data);
          if (parsed.remark) console.error("Overpass remark:", parsed.remark);
          const allEls = parsed.elements || [];
          if (allEls.length === 0) console.error("Overpass returned 0 elements. Response start:", data.slice(0, 200));
          // Deduplicate by type+id (nwr can return same place as way AND relation)
          const seen = new Set();
          const els = allEls.filter(e => {
            const key = `${e.type}:${e.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          const pharmacies = els.filter(e => e.tags?.amenity === "pharmacy").length;
          const restaurants = els.filter(e => ["restaurant","cafe"].includes(e.tags?.amenity)).length;
          const bars = els.filter(e => ["bar","pub","wine_bar"].includes(e.tags?.amenity)).length;

          const count = (tagPairs) => els.filter(e =>
            tagPairs.some(([k, v]) => e.tags?.[k] === v)
          ).length;

          const supermarkets = count(tags.supermarkets || []);
          const gyms        = count(tags.gyms || []);
          const parks       = count(tags.parks || []);
          const intlSchools = count(tags.schools || []);
          const museums     = count(tags.museums || []);

          const TRANSIT_MATCHERS = [
            e => e.tags?.railway === "station",
            e => e.tags?.railway === "subway_entrance",
            e => e.tags?.railway === "tram_stop",
            e => e.tags?.railway === "halt",
            e => e.tags?.station === "subway",
            e => e.tags?.public_transport === "stop_position" && (e.tags?.tram === "yes" || e.tags?.subway === "yes"),
          ];
          const nearestMetro = els
            .filter(e => TRANSIT_MATCHERS.some(fn => fn(e)) && e.tags?.name)
            .map(e => e.tags.name)
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 4);

          // Coords for map pins — nodes have lat/lon, ways/relations have center
          const coord = e => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, name: e.tags?.name || '' });
          const hasLatLon = c => c.lat && c.lon;

          const transitCoords = els.filter(e => TRANSIT_MATCHERS.some(fn => fn(e))).map(coord).filter(hasLatLon)
            .filter((v, i, a) => a.findIndex(x => x.name === v.name) === i).slice(0, 10);
          const supermarketCoords = els.filter(e => (tags.supermarkets||[]).some(([k,v]) => e.tags?.[k]===v)).map(coord).filter(hasLatLon).slice(0, 10);
          const gymCoords = els.filter(e => (tags.gyms||[]).some(([k,v]) => e.tags?.[k]===v)).map(coord).filter(hasLatLon).slice(0, 10);

          resolve({ pharmacies, supermarkets, parks, gyms, intlSchools, museums, restaurants, bars, nearestMetro, transitCoords, supermarketCoords, gymCoords });
        } catch (e) {
          console.error("Overpass batch parse error:", e.message, data?.slice(0, 120));
          resolve(empty);
        }
      });
      res.on("error", () => resolve(empty));
    });

    req.on("error", () => resolve(empty));
    req.write(body);
    req.end();
  });
}

// Format Foursquare venue
function formatVenue(venue, city) {
  const name = venue.name || "Unknown";
  const address = venue.location?.formatted_address || venue.location?.address || "";
  const rating = venue.rating ? ` · ${venue.rating}/10` : "";
  const description = address ? `${address}${rating}` : `Local favourite${rating}`;
  return { name, description, googleMapsQuery: `${name} ${city}` };
}

// Fast enrichment — Foursquare venues only, no slow Overpass calls
async function enrichMatchFast(match, destCity) {
  if (!match.lat || !match.lng) return match;
  try {
    const [restaurants, bars] = await Promise.all([
      searchFoursquare(match.lat, match.lng, "restaurant", "13000", 3),
      searchFoursquare(match.lat, match.lng, "wine bar", "13003,13062", 3),
    ]);
    if (restaurants.length > 0) match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity));
    if (bars.length > 0) match.top3WineBars = bars.map(v => formatVenue(v, destCity));
  } catch (err) {
    console.error("Fast enrichment error for", match.name, err.message);
  }
  return match;
}

// ── OSM TAG MAPPING BY CITY ─────────────────────────────────────────────────
const CITY_TAGS = {
  // Portugal
  "Lisbon": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Porto":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // UK
  "London": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // France
  "Paris":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Spain
  "Barcelona": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Madrid":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Seville":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Netherlands
  "Amsterdam": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Italy
  "Rome":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Florence": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","halt"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Milan":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Germany
  "Berlin":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Munich":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Frankfurt":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Düsseldorf":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Other Europe
  "Vienna":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Copenhagen":{ supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Stockholm": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Prague":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Budapest":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Brussels":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Istanbul":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Americas
  "New York":      { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Los Angeles":   { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "San Francisco": { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Chicago":       { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Miami":         { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Boston":        { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Washington DC": { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Toronto":       { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Montreal":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Mexico City":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "São Paulo":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Rio de Janeiro":{ supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Buenos Aires":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","plaza"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Asia Pacific
  "Tokyo":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Seoul":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Singapore": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Dubai":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Sydney":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Melbourne": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Bangkok":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Beijing":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Shanghai":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Bali":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["amenity","bus_station"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  // Africa & Middle East
  "Cape Town":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","nature_reserve"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
  "Marrakech":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["amenity","bus_station"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]]},
};

// Default fallback tags for cities not in mapping
const DEFAULT_TAGS = {
  supermarkets: [["shop","supermarket"],["shop","convenience"]],
  transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]],
  schools: [["amenity","school"],["amenity","college"]],
  gyms: [["leisure","fitness_centre"],["amenity","gym"]],
  parks: [["leisure","park"],["leisure","garden"]],
  museums: [["tourism","museum"],["tourism","attraction"],["amenity","arts_centre"],["tourism","gallery"]],
};



async function enrichMatch(match, destCity, intent) {
  if (!match.lat || !match.lng) return match;

  try {
    const [restaurants, bars] = await Promise.all([
      searchFoursquare(match.lat, match.lng, "restaurant", "13000", 3),
      searchFoursquare(match.lat, match.lng, "wine bar", "13003,13062", 3),
    ]);

    if (restaurants.length > 0) match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity));
    if (bars.length > 0) match.top3WineBars = bars.map(v => formatVenue(v, destCity));

    // ONE batched Overpass call for all amenities + transit
    const amenityData = await fetchAllAmenities(match.lat, match.lng, destCity);

    if (amenityData.nearestMetro.length > 0) match.nearestMetro = amenityData.nearestMetro;

    if (intent === "move") {
      match.amenities = {
        pharmacies:   amenityData.pharmacies,
        supermarkets: amenityData.supermarkets,
        parks:        amenityData.parks,
        gyms:         amenityData.gyms,
        intlSchools:  amenityData.intlSchools,
        museums:      amenityData.museums,
      };
    }

  } catch (err) {
    console.error("Enrichment error for", match.name, err.message);
  }

  return match;
}

// ── PROMPTS ─────────────────────────────────────────────────────────────────
function buildPrompt(safehomeHood, safehomeCity, safedestCity, safeVibes, intent, excludeHood) {
  const vibeContext = safeVibes
    ? `\nThe traveller especially values: ${safeVibes}. Weight these heavily.`
    : "";
  const excludeContext = excludeHood
    ? `\nDo NOT suggest "${excludeHood}" — the user has already seen it and wants a different option.`
    : "";

  if (intent === "move") {
    return `You are MatchMyHood, an expert neighbourhood matching tool for people relocating.

A person loves "${safehomeHood}" in ${safehomeCity}. They are RELOCATING long-term to ${safedestCity}.${vibeContext}${excludeContext}

Find the single BEST matching neighbourhood in ${safedestCity} based on character, daily life quality, community feel, cost, and liveability.

CRITICAL RULES:
- Neighbourhoods must genuinely exist in ${safedestCity}
- Match character genuinely — family area = family area, creative hub = creative hub
- lat/lng must be the EXACT neighbourhood centre coordinates
- Be honest about downsides — this helps people make real decisions

Respond ONLY with a valid JSON array, no markdown:
[
  {
    "name": "Neighbourhood Name",
    "city": "${safedestCity}",
    "matchScore": 92,
    "tagline": "One evocative sentence",
    "whyItMatches": "2 sentences explaining why this matches ${safehomeHood} for living.",
    "vibes": ["tag1", "tag2", "tag3"],
    "pros": ["Great public transport", "Excellent local market", "Strong expat community"],
    "cons": ["Limited English spoken", "Can be noisy on weekends", "Fewer green spaces"],
    "averageRent1bed": "€900-1200/month",
    "costLevel": "Mid-range",
    "walkScore": "High",
    "safetyRating": "Very safe",
    "bestFor": "Who this neighbourhood suits best for living",
    "top3Restaurants": [
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"}
    ],
    "top3WineBars": [
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"}
    ],
    "top3ThingsToDo": [
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false}
    ],
    "mustTry": "One iconic local food or drink and where",
    "unsplashQuery": "3-4 word photo query",
    "lat": 41.1234,
    "lng": -8.6789
  }
]

Rules: 1 result only, score 88-96%, JSON array with one object, lat/lng = exact neighbourhood centre.`;

  } else {
    return `You are MatchMyHood, an expert neighbourhood matching tool for travellers.

A person loves "${safehomeHood}" in ${safehomeCity}. They are VISITING ${safedestCity} as a traveller.${vibeContext}${excludeContext}

Find the single BEST matching neighbourhood in ${safedestCity} to stay in, based on character, energy, food scene, nightlife, and walkability.

CRITICAL RULES:
- Neighbourhoods must genuinely exist in ${safedestCity}
- Match character genuinely — gritty creative = gritty creative, not polished riverside
- lat/lng must be the EXACT neighbourhood centre coordinates
- Be honest about downsides for visitors — noise, tourist density, safety at night etc.

Respond ONLY with a valid JSON array, no markdown:
[
  {
    "name": "Neighbourhood Name",
    "city": "${safedestCity}",
    "matchScore": 92,
    "tagline": "One evocative sentence",
    "whyItMatches": "2 sentences explaining why this matches ${safehomeHood} for a visit.",
    "vibes": ["tag1", "tag2", "tag3"],
    "pros": ["Amazing food scene", "Very walkable", "Great nightlife"],
    "cons": ["Noisy at night — light sleepers beware", "Very touristy on weekends", "Limited parking"],
    "costLevel": "Mid-range",
    "walkScore": "High",
    "safetyRating": "Very safe",
    "bestFor": "Who this neighbourhood suits best for a visit",
    "top3Restaurants": [
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"}
    ],
    "top3WineBars": [
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"},
      {"name": "Name", "description": "Short line", "googleMapsQuery": "Name ${safedestCity}"}
    ],
    "top3ThingsToDo": [
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": true},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false}
    ],
    "mustTry": "One iconic food or drink and where to get it",
    "unsplashQuery": "3-4 word photo query",
    "lat": 41.1234,
    "lng": -8.6789
  }
]

Rules: 1 result only, score 88-96%, JSON array with one object, lat/lng = exact neighbourhood centre.`;
  }
}

// ── MAIN ROUTE ───────────────────────────────────────────────────────────────
app.post("/api/match", async (req, res) => {
  const { homeCity, homeHood, destCity, vibes, intent, excludeHood } = req.body;

  if (!homeCity || !homeHood || !destCity) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (homeCity === destCity) {
    return res.status(400).json({ error: "Home city and destination must be different" });
  }

  const sanitise = (str) => str.replace(/[<>{}]/g, "").slice(0, 80);
  const safehomeCity = sanitise(homeCity);
  const safehomeHood = sanitise(homeHood);
  const safedestCity = sanitise(destCity);
  const safeVibes = Array.isArray(vibes) ? vibes.map(v => sanitise(v)).join(", ") : "";
  const safeExcludeHood = excludeHood ? sanitise(excludeHood) : null;
  const currentIntent = intent === "move" ? "move" : "visit";

  try {
    // Step 1: Claude — neighbourhood matches with intent-specific fields
    const prompt = buildPrompt(safehomeHood, safehomeCity, safedestCity, safeVibes, currentIntent, safeExcludeHood);
    const text = await callClaude(prompt);
    const cleaned = text.replace(/```json|```/g, "").trim();
    let matches = JSON.parse(cleaned);

    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error("Invalid response format");
    }

    // Fast enrichment — single match (Foursquare only)
    matches = await Promise.all(
      matches.map(m => enrichMatchFast(m, safedestCity))
    );

    return res.json({ matches, intent: currentIntent });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── BACKGROUND AMENITIES ENDPOINT ───────────────────────────────────────────
// Called by frontend after results are shown — enriches with slow Overpass data
app.post("/api/amenities", async (req, res) => {
  const { matches, destCity } = req.body;
  if (!matches || !Array.isArray(matches)) {
    return res.status(400).json({ error: "Missing matches" });
  }

  try {
    const enriched = [];
    for (const m of matches) {
      if (!m.lat || !m.lng) { enriched.push(m); continue; }

      try {
        // ONE batched Overpass call per neighbourhood
        const amenityData = await fetchAllAmenities(m.lat, m.lng, destCity);

        if (amenityData.nearestMetro.length > 0) m.nearestMetro = amenityData.nearestMetro;
        if (amenityData.transitCoords?.length)     m.transitCoords     = amenityData.transitCoords;
        if (amenityData.supermarketCoords?.length)  m.supermarketCoords  = amenityData.supermarketCoords;
        if (amenityData.gymCoords?.length)          m.gymCoords          = amenityData.gymCoords;

        m.amenities = {
          pharmacies:   amenityData.pharmacies,
          supermarkets: amenityData.supermarkets,
          parks:        amenityData.parks,
          gyms:         amenityData.gyms,
          intlSchools:  amenityData.intlSchools,
          museums:      amenityData.museums,
          restaurants:  amenityData.restaurants,
          bars:         amenityData.bars,
        };

      } catch (e) {
        console.error("Amenity error for", m.name, e.message);
      }

      enriched.push(m);
      // Brief pause between neighbourhoods to be polite to Overpass
      await new Promise(r => setTimeout(r, 500));
    }

    return res.json({ matches: enriched });

  } catch (err) {
    console.error("Amenities error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MatchMyHood API running on port ${PORT}`));
