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
      max_tokens: 4000,
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

// ── OVERPASS API (OpenStreetMap) — transport & amenities ───────────────────
function queryOverpass(lat, lng, radius, key, value) {
  return new Promise((resolve) => {
    const query = `[out:json][timeout:15];node["${key}"="${value}"](around:${radius},${lat},${lng});out count;`;
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
          const parsed = JSON.parse(data);
          const countEl = parsed.elements?.[0];
          const total = countEl?.tags?.total || countEl?.tags?.nodes || 0;
          resolve(parseInt(total) || 0);
        } catch (e) {
          console.error("Overpass parse error:", e.message, data?.slice(0, 100));
          resolve(0);
        }
      });
      res.on("error", () => resolve(0));
    });

    req.on("error", () => resolve(0));
    req.write(body);
    req.end();
  });
}

// Get nearest metro/subway stations
function getNearestTransit(lat, lng) {
  return new Promise((resolve) => {
    const query = `[out:json][timeout:10];
(
  node["railway"="station"](around:800,${lat},${lng});
  node["railway"="subway_entrance"](around:800,${lat},${lng});
  node["station"="subway"](around:800,${lat},${lng});
);
out 3;`;

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
          const parsed = JSON.parse(data);
          const stations = (parsed.elements || [])
            .filter(e => e.tags?.name)
            .map(e => e.tags.name)
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 3);
          resolve(stations);
        } catch {
          resolve([]);
        }
      });
      res.on("error", () => resolve([]));
    });

    req.on("error", () => resolve([]));
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

// ── ENRICH WITH FOURSQUARE + OVERPASS ──────────────────────────────────────
async function enrichMatch(match, destCity, intent) {
  if (!match.lat || !match.lng) return match;

  try {
    // Foursquare calls can run in parallel (different API)
    const [restaurants, bars] = await Promise.all([
      searchFoursquare(match.lat, match.lng, "restaurant", "13000", 3),
      searchFoursquare(match.lat, match.lng, "wine bar", "13003,13062", 3),
    ]);

    if (restaurants.length > 0) match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity));
    if (bars.length > 0) match.top3WineBars = bars.map(v => formatVenue(v, destCity));

    // All Overpass calls staggered to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
    const transitStations = await getNearestTransit(match.lat, match.lng);
    if (transitStations.length > 0) match.nearestMetro = transitStations;

    // For LIVE intent, get additional amenity counts
    if (intent === "move") {
      await new Promise(r => setTimeout(r, 200));
      const pharmacies = await queryOverpass(match.lat, match.lng, 700, "amenity", "pharmacy");
      await new Promise(r => setTimeout(r, 150));
      const supermarkets = await queryOverpass(match.lat, match.lng, 700, "shop", "supermarket");
      await new Promise(r => setTimeout(r, 150));
      const parks = await queryOverpass(match.lat, match.lng, 900, "leisure", "park");
      await new Promise(r => setTimeout(r, 150));
      const gyms1 = await queryOverpass(match.lat, match.lng, 700, "leisure", "fitness_centre");
      await new Promise(r => setTimeout(r, 150));
      const gyms2 = await queryOverpass(match.lat, match.lng, 700, "amenity", "gym");
      const gyms = gyms1 + gyms2;
      await new Promise(r => setTimeout(r, 150));
      const intlSchools = await queryOverpass(match.lat, match.lng, 2000, "amenity", "school");

      match.amenities = { pharmacies, supermarkets, parks, gyms, intlSchools };
    }

  } catch (err) {
    console.error("Enrichment error for", match.name, err.message);
  }

  return match;
}

// ── PROMPTS ─────────────────────────────────────────────────────────────────
function buildPrompt(safehomeHood, safehomeCity, safedestCity, safeVibes, intent) {
  const vibeContext = safeVibes
    ? `\nThe traveller especially values: ${safeVibes}. Weight these heavily.`
    : "";

  if (intent === "move") {
    return `You are MatchMyHood, an expert neighbourhood matching tool for people relocating.

A person loves "${safehomeHood}" in ${safehomeCity}. They are RELOCATING long-term to ${safedestCity}.${vibeContext}

Find the TOP 3 matching neighbourhoods in ${safedestCity} based on character, daily life quality, community feel, cost, and liveability.

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

Rules: 3 results, descending scores (88-96%, 82-91%, 78-88%), JSON only, lat/lng = exact neighbourhood centre.`;

  } else {
    return `You are MatchMyHood, an expert neighbourhood matching tool for travellers.

A person loves "${safehomeHood}" in ${safehomeCity}. They are VISITING ${safedestCity} as a traveller.${vibeContext}

Find the TOP 3 matching neighbourhoods in ${safedestCity} to stay in, based on character, energy, food scene, nightlife, and walkability.

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

Rules: 3 results, descending scores (88-96%, 82-91%, 78-88%), JSON only, lat/lng = exact neighbourhood centre.`;
  }
}

// ── MAIN ROUTE ───────────────────────────────────────────────────────────────
app.post("/api/match", async (req, res) => {
  const { homeCity, homeHood, destCity, vibes, intent } = req.body;

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
  const currentIntent = intent === "move" ? "move" : "visit";

  try {
    // Step 1: Claude — neighbourhood matches with intent-specific fields
    const prompt = buildPrompt(safehomeHood, safehomeCity, safedestCity, safeVibes, currentIntent);
    const text = await callClaude(prompt);
    const cleaned = text.replace(/```json|```/g, "").trim();
    let matches = JSON.parse(cleaned);

    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error("Invalid response format");
    }

    // Fast enrichment only — Foursquare + transit (no slow Overpass amenity counts)
    const enriched = [];
    for (const m of matches) {
      const result = await enrichMatchFast(m, safedestCity);
      enriched.push(result);
    }
    matches = enriched;

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
        await new Promise(r => setTimeout(r, 100));
        const transitStations = await getNearestTransit(m.lat, m.lng);
        if (transitStations.length > 0) m.nearestMetro = transitStations;

        await new Promise(r => setTimeout(r, 200));
        const pharmacies = await queryOverpass(m.lat, m.lng, 700, "amenity", "pharmacy");
        await new Promise(r => setTimeout(r, 150));
        const supermarkets = await queryOverpass(m.lat, m.lng, 700, "shop", "supermarket");
        await new Promise(r => setTimeout(r, 150));
        const parks = await queryOverpass(m.lat, m.lng, 900, "leisure", "park");
        await new Promise(r => setTimeout(r, 150));
        const gyms1 = await queryOverpass(m.lat, m.lng, 700, "leisure", "fitness_centre");
        await new Promise(r => setTimeout(r, 150));
        const gyms2 = await queryOverpass(m.lat, m.lng, 700, "amenity", "gym");
        await new Promise(r => setTimeout(r, 150));
        const intlSchools = await queryOverpass(m.lat, m.lng, 2000, "amenity", "school");

        m.amenities = {
          pharmacies,
          supermarkets,
          parks,
          gyms: gyms1 + gyms2,
          intlSchools
        };
      } catch (e) {
        console.error("Amenity error for", m.name, e.message);
      }

      enriched.push(m);
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
