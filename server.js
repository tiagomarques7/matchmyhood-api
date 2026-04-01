const https = require("https");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || "AIzaSyAvKFFCzz8O3-y_vRTdMdrbl16bHMgpXCA";
const HERE_API_KEY = process.env.HERE_API_KEY || "USB-MLS9zHPgoHI_Z9OfkHuCpUhRcRoE9Cw_0VKv0jQ";

// ── SUPABASE CLIENT ──────────────────────────────────────────────────────────
// Lazy-initialised — silently no-ops if env vars are absent (keeps existing
// Claude flow fully intact until Supabase is configured on DO).
let _supabaseClient = null;

function getSupabase() {
  if (_supabaseClient) return _supabaseClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabaseClient = createClient(url, key);
    console.log("Supabase client initialised");
    return _supabaseClient;
  } catch (e) {
    console.error("Supabase init failed (is @supabase/supabase-js installed?):", e.message);
    return null;
  }
}

// Normalise a neighbourhood name + city into a Supabase slug
// "Príncipe Real" + "Lisbon" → "principe-real-lisbon"
function toSlug(name, city) {
  const clean = (str) =>
    str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")   // strip accents
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")        // strip punctuation
      .trim()
      .replace(/\s+/g, "-");
  return `${clean(name)}-${clean(city)}`;
}

// Look up a matched neighbourhood in Supabase and return pre-curated venues.
// Returns { restaurants, bars, cafes } arrays (same shape as enrichMatchFast output),
// or null if the neighbourhood / city is not seeded.
//
// vibesStr: comma-separated string from the match request (e.g. "Food & Restaurants, Wine & Nightlife")
// The function scores venues by vibe-tag overlap so the most relevant ones surface first.
async function lookupSupabase(matchName, destCity, vibesStr) {
  const sb = getSupabase();
  if (!sb) return null;

  const slug = toSlug(matchName, destCity);
  console.log(`Supabase lookup: ${slug}`);

  try {
    // 1. Does this neighbourhood exist in Supabase?
    const { data: hood, error: hoodErr } = await sb
      .from("neighbourhoods")
      .select("id, name, city")
      .eq("slug", slug)
      .single();

    if (hoodErr || !hood) {
      console.log(`Supabase miss: ${slug}`);
      return null;
    }

    // 2. Fetch all venues for this neighbourhood, including their vibe tags
    // Also fetch radius_m from neighbourhood
    const { data: hoodDetail } = await sb
      .from("neighbourhoods")
      .select("radius_m")
      .eq("id", hood.id)
      .single();
    const radiusM = hoodDetail?.radius_m || 500;

    const { data: venues, error: venueErr } = await sb
      .from("venues")
      .select(`
        id, name, type, description, price_level, website,
        lat, lng, photo_url, notable,
        venue_vibes(vibe_tag)
      `)
      .eq("neighbourhood_id", hood.id);

    if (venueErr || !venues || venues.length === 0) {
      console.log(`Supabase: no venues for ${slug}`);
      return null;
    }

    // 3. Parse user vibes into lowercase keywords for overlap scoring
    const userVibeKeywords = (vibesStr || "")
      .split(",")
      .map(v => v.trim().toLowerCase())
      .filter(Boolean);

    // Vibe-tag → keyword map for overlap matching
    const VIBE_KEYWORDS = {
      "food & restaurants": ["local-favourite", "unmissable", "michelin", "petiscos", "traditional", "contemporary", "seafood"],
      "wine & nightlife":   ["wine-focused", "cocktails", "nightlife", "late-night", "fado", "live-music", "craft-beer"],
      "cafés & chill":      ["brunch", "solo-friendly", "budget-friendly", "bohemian"],
      "culture & architecture": ["historic-interior", "views", "design-interior"],
      "off the beaten track":   ["hidden-gem", "local-favourite"],
      "lgbt+ friendly":         ["nightlife", "bohemian", "contemporary"],
      "affordable":             ["under-15", "budget-friendly", "local-favourite"],
    };

    // Build relevant tag set from user's vibes
    const relevantTags = new Set();
    for (const kw of userVibeKeywords) {
      for (const [vibeKey, tags] of Object.entries(VIBE_KEYWORDS)) {
        if (vibeKey.includes(kw) || kw.includes(vibeKey.split(" ")[0])) {
          tags.forEach(t => relevantTags.add(t));
        }
      }
    }

    // 4. Score + sort venues
    const scored = venues.map(v => {
      const tags = (v.venue_vibes || []).map(vt => vt.vibe_tag);
      let score = 0;

      // Unmissable always wins
      if (tags.includes("unmissable")) score += 50;
      if (v.notable)                   score += 20;

      // Vibe overlap
      for (const t of tags) {
        if (relevantTags.has(t)) score += 10;
      }

      return { ...v, _score: score, _tags: tags };
    });

    // 5. Split by type, filter to venues with coordinates, take top picks
    const byType = (type, limit) =>
      scored
        .filter(v => v.type === type && v.lat && v.lng)
        .sort((a, b) => b._score - a._score)
        .slice(0, limit);

    // Rewrite Google Places photo URLs to go through our proxy
    // Stored format: https://maps.googleapis.com/maps/api/place/photo?...&photoreference=REF&key=...
    const proxyPhoto = (url) => {
      if (!url) return null;
      try {
        const match = url.match(/photoreference=([^&]+)/);
        if (match) return `https://api.matchmyhood.com/api/photo?ref=${match[1]}`;
      } catch(e) {}
      return null;
    };

    const fmt = (v) => ({
      name:            v.name,
      description:     `${v.description || ""}${v.price_level ? " · " + (["","€","€€","€€€"][v.price_level] || "") : ""}`.trim(),
      googleMapsQuery: `${v.name} ${hood.name} ${hood.city}`,
      photoUrl:        proxyPhoto(v.photo_url),
      openStatus:      null,
      website:         v.website || null,
      primaryType:     v.type,
      lat:             v.lat,
      lng:             v.lng,
      tags:            [...new Set((v.venue_vibes || []).map(vt => vt.vibe_tag))],
    });

    const restaurants = byType("restaurant", 5).map(fmt);
    const bars        = byType("bar",        4).map(fmt);
    const cafes       = byType("cafe",       3).map(fmt);

    if (restaurants.length === 0 && bars.length === 0 && cafes.length === 0) {
      console.log(`Supabase: venues exist for ${slug} but none have coordinates yet`);
      return null;
    }

    console.log(`Supabase HIT: ${hood.name} → ${restaurants.length}R ${bars.length}B ${cafes.length}C (radius: ${radiusM}m)`);
    return { restaurants, bars, cafes, radius_m: radiusM };

  } catch (err) {
    console.error("Supabase lookup error:", err.message);
    return null;  // always fall through to Claude
  }
}

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

// ── GOOGLE PLACES API ────────────────────────────────────────────────────────
// Search for top venues by type — used for top 3 recommendations
// Valid primary types per category — used to filter out misclassified venues
const VALID_RESTAURANT_TYPES = new Set(['restaurant','meal_takeaway','meal_delivery','food','cafe','bakery','bar','pub']);
const VALID_BAR_TYPES        = new Set(['bar','pub','night_club','wine_bar','liquor_store','restaurant','cafe']);
const VALID_CAFE_TYPES        = new Set(['cafe','coffee_shop','bakery','breakfast_restaurant']);

function searchGoogle(lat, lng, types, limit = 3) {
  // Fetch 10 candidates, sort by rating descending, filter by primaryType, return top 'limit'
  return new Promise((resolve) => {
    const body = JSON.stringify({
      includedTypes: types,
      maxResultCount: 10,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 800 } },
      rankPreference: "POPULARITY"
    });
    const req = https.request({
      hostname: "places.googleapis.com",
      path: "/v1/places:searchNearby",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.displayName,places.rating,places.priceLevel,places.shortFormattedAddress,places.photos,places.currentOpeningHours,places.websiteUri,places.primaryType,places.location",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          let places = JSON.parse(data).places || [];
          // Filter by primaryType to drop misclassified venues
          const validTypes = types.some(t => ["bar","wine_bar"].includes(t)) ? VALID_BAR_TYPES : VALID_RESTAURANT_TYPES;
          const typed = places.filter(p => !p.primaryType || validTypes.has(p.primaryType));
          // If filter is too aggressive (fewer results than limit), fall back to all places
          const filtered = typed.length >= limit ? typed : places;
          // Sort by rating descending, unrated venues go last
          filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
          resolve(filtered.slice(0, limit));
        }
        catch { resolve([]); }
      });
      res.on("error", () => resolve([]));
    });
    req.on("error", () => resolve([]));
    req.write(body);
    req.end();
  });
}

// Count venues via Google Places — used for amenity tile counts
function countGoogle(lat, lng, types, radius = 600) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      includedTypes: types,
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: radius } }
    });
    const req = https.request({
      hostname: "places.googleapis.com",
      path: "/v1/places:searchNearby",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.id",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const count = (JSON.parse(data).places || []).length;
          // Google caps at 20 — return "20+" string when capped so UI shows there are more
          resolve(count >= 20 ? "20+" : count);
        }
        catch { resolve(0); }
      });
      res.on("error", () => resolve(0));
    });
    req.on("error", () => resolve(0));
    req.write(body);
    req.end();
  });
}

// ── HERE PLACES API — venue counts for hybrid best-of-both approach ──────────
// Returns count of venues matching category near lat/lng
// HERE Browse API: up to 100 results, excellent global coverage
function countHere(lat, lng, categories, radius = 700) {
  return new Promise((resolve) => {
    if (!HERE_API_KEY) return resolve(0);
    const params = `at=${lat},${lng}&categories=${categories}&in=circle:${lat},${lng};r=${radius}&limit=100&apiKey=${HERE_API_KEY}`;
    const req = https.request({
      hostname: 'browse.search.hereapi.com',
      path: `/v1/browse?${params}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const count = (parsed.items || []).length;
          resolve(count);
        } catch { resolve(0); }
      });
      res.on('error', () => resolve(0));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

// HERE category IDs for our amenity types
// See: https://developer.here.com/documentation/geocoding-search-api/dev_guide/topics/place-categories/places-category-system-full.html
const HERE_CATEGORIES = {
  restaurants:  '100-1000-0000', // Restaurant
  bars:         '200-2000-0011', // Bar or Pub
  cafes:        '100-1100-0010', // Coffee Shop
  gyms:         '400-4300-0278', // Fitness, Health & Gyms
  supermarkets: '600-6300-0066', // Grocery/Supermarket
  pharmacies:   '800-8000-0164', // Pharmacy
};

// ── OVERPASS API — single batched query per neighbourhood ──────────────────
// Fetches ALL amenity types + transit in ONE request to avoid rate limiting
let _lastOverpassCall = 0;

function fetchAllAmenities(lat, lng, city, polygon) {
  const tags = CITY_TAGS[city] || DEFAULT_TAGS;

  // Build Overpass area filter — use polygon if available, else radius
  // Overpass poly: format is "lat1 lon1 lat2 lon2 ..." (space-separated, flat)
  let areaFilter;
  if (polygon) {
    try {
      let coords = polygon.type === 'Polygon'
        ? polygon.coordinates[0]
        : polygon.coordinates[0][0]; // first ring of MultiPolygon
      // Overpass poly: needs lat lon pairs (note: GeoJSON is lon,lat so we swap)
      const polyStr = coords.map(c => `${c[1]} ${c[0]}`).join(' ');
      areaFilter = (tag) => `(poly:"${polyStr}")`;
    } catch(e) {
      console.error('Polygon parse error, falling back to radius:', e.message);
      areaFilter = (radius) => `(around:${radius},${lat},${lng})`;
    }
  } else {
    areaFilter = (radius) => `(around:${radius},${lat},${lng})`;
  }

  return new Promise(async (resolve) => {
    const empty = { pharmacies: 0, supermarkets: 0, parks: 0, gyms: 0, intlSchools: 0, museums: 0, restaurants: 0, bars: 0, nearestMetro: [] };

    // Build union of all nwr (node/way/relation) queries
    const parts = [
      `nwr["amenity"="pharmacy"]${areaFilter(700)};`,
      `nwr["amenity"="restaurant"]${areaFilter(600)};`,
      `nwr["amenity"="cafe"]${areaFilter(600)};`,
      `nwr["amenity"="bar"]${areaFilter(600)};`,
      `nwr["amenity"="pub"]${areaFilter(600)};`,
      `nwr["amenity"="wine_bar"]${areaFilter(600)};`,
    ];
    for (const [k, v] of (tags.supermarkets || []))
      parts.push(`nwr["${k}"="${v}"]${areaFilter(700)};`);
    for (const [k, v] of (tags.gyms || []))
      parts.push(`nwr["${k}"="${v}"]${areaFilter(700)};`);
    for (const [k, v] of (tags.parks || []))
      parts.push(`nwr["${k}"="${v}"]${areaFilter(900)};`);
    for (const [k, v] of (tags.schools || []))
      parts.push(`nwr["${k}"="${v}"]${areaFilter(2000)};`);
    for (const [k, v] of (tags.museums || []))
      parts.push(`nwr["${k}"="${v}"]${areaFilter(1500)};`);
    // Transit — always use radius (stations can be just outside hood boundary)
    parts.push(
      `nwr["railway"="station"](around:2000,${lat},${lng});`,
      `node["railway"="subway_entrance"](around:2000,${lat},${lng});`,
      `node["railway"="tram_stop"](around:2000,${lat},${lng});`,
      `node["railway"="halt"](around:2000,${lat},${lng});`,
      `nwr["station"="subway"](around:2000,${lat},${lng});`,
      `node["public_transport"="stop_position"]["tram"="yes"](around:2000,${lat},${lng});`,
      `node["public_transport"="stop_position"]["subway"="yes"](around:2000,${lat},${lng});`,
      `node["highway"="bus_stop"](around:400,${lat},${lng});`,
      `node["public_transport"="stop_position"]["bus"="yes"](around:400,${lat},${lng});`,
      // Entertainment & culture
      `nwr["amenity"="cinema"]${areaFilter(1000)};`,
      `nwr["amenity"="theatre"]${areaFilter(1000)};`,
      `nwr["amenity"="music_venue"]${areaFilter(1000)};`,
      `nwr["amenity"="nightclub"]${areaFilter(800)};`,
      `nwr["amenity"="marketplace"]${areaFilter(1000)};`,
      `nwr["shop"="market"]${areaFilter(1000)};`,
      // Hospitals (LIVE mode)
      `nwr["amenity"="hospital"]${areaFilter(1500)};`,
      `nwr["amenity"="clinic"]${areaFilter(1000)};`
    );

    const query = `[out:json][timeout:45];\n(\n${parts.join('\n')}\n);\nout center tags;`;
    const body = `data=${encodeURIComponent(query)}`;

    // Throttle: enforce 35s gap between Overpass calls (rate limit window)
    const gap = Math.max(0, (_lastOverpassCall + 35000) - Date.now());
    if (gap > 0) console.log(`Overpass throttle: waiting ${Math.round(gap/1000)}s`);
    await new Promise(r => setTimeout(r, gap));
    _lastOverpassCall = Date.now();

    // Mirror cascade — try each in order until one returns valid JSON
    // z./lz4. are separate server pools from main overpass-api.de
    const MIRRORS = [
      "overpass-api.de",
      "z.overpass-api.de",
      "lz4.overpass-api.de",
      "overpass.kumi.systems",
    ];

    async function tryMirror(hostname) {
      return new Promise((res, rej) => {
        const r = https.request({
          hostname, path: "/api/interpreter", method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
        }, (response) => {
          let d = "";
          response.on("data", chunk => d += chunk);
          response.on("end", () => {
            if (d.trimStart().startsWith("<")) rej(new Error(`${hostname} rate-limited`));
            else res(d);
          });
          response.on("error", rej);
        });
        r.on("error", rej);
        r.write(body);
        r.end();
      });
    }

    let rawData = null;
    for (const mirror of MIRRORS) {
      try {
        rawData = await tryMirror(mirror);
        console.log(`Overpass ${mirror} OK — ${JSON.parse(rawData).elements?.length ?? 0} elements`);
        break;
      } catch(e) {
        console.error(`Overpass ${mirror} failed: ${e.message}`);
        if (mirror !== MIRRORS[MIRRORS.length - 1]) {
          await new Promise(r => setTimeout(r, 2000)); // 2s between mirror attempts
        }
      }
    }

    if (!rawData) {
      console.error("All Overpass mirrors failed — returning empty");
      resolve(empty);
      return;
    }

    function processOverpass(data) {
      const parsed = JSON.parse(data);
      if (parsed.remark) console.error("Overpass remark:", parsed.remark);
      const allEls = parsed.elements || [];
      if (allEls.length === 0) console.error("Overpass returned 0 elements. Response start:", data.slice(0, 200));
      const seen = new Set();
      const els = allEls.filter(e => {
        const key = `${e.type}:${e.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const pharmacies  = els.filter(e => e.tags?.amenity === "pharmacy").length;
      const restaurants = els.filter(e => e.tags?.amenity === "restaurant").length;
      const cafes       = els.filter(e => e.tags?.amenity === "cafe").length;
      const bars        = els.filter(e => ["bar","pub","wine_bar"].includes(e.tags?.amenity)).length;

      const count = (tagPairs) => els.filter(e =>
        tagPairs.some(([k, v]) => e.tags?.[k] === v)
      ).length;

      const supermarkets = count(tags.supermarkets || []);
      const gyms         = count(tags.gyms || []);
      const parks        = els.filter(e => (tags.parks||[]).some(([k,v]) => e.tags?.[k]===v) && e.tags?.name).length;
      const intlSchools  = els.filter(e => {
        if (!(tags.schools||[]).some(([k,v]) => e.tags?.[k]===v)) return false;
        const n = (e.tags?.name || '').toLowerCase();
        return n.includes('international') || n.includes('british') ||
               n.includes('american') || n.includes('french') ||
               n.includes('german') || n.includes('lycée') ||
               n.includes('deutsch') || n.includes('escola inter');
      }).length;
      const museums      = els.filter(e => (tags.museums||[]).some(([k,v]) => e.tags?.[k]===v) && e.tags?.name).length;

      const cinemas      = els.filter(e => e.tags?.amenity === "cinema").length;
      const theatres     = els.filter(e => e.tags?.amenity === "theatre").length;
      const musicVenues  = els.filter(e => e.tags?.amenity === "music_venue" || e.tags?.amenity === "nightclub").length;
      const markets      = els.filter(e => e.tags?.amenity === "marketplace" || e.tags?.shop === "market").length;
      const hospitals    = els.filter(e => e.tags?.amenity === "hospital" || e.tags?.amenity === "clinic").length;

      const HEAVY_TRANSIT_MATCHERS = [
        e => e.tags?.railway === "station",
        e => e.tags?.railway === "subway_entrance",
        e => e.tags?.railway === "tram_stop",
        e => e.tags?.railway === "halt",
        e => e.tags?.station === "subway",
        e => e.tags?.public_transport === "stop_position" && (e.tags?.tram === "yes" || e.tags?.subway === "yes"),
      ];
      const BUS_MATCHERS = [
        e => e.tags?.highway === "bus_stop",
        e => e.tags?.public_transport === "stop_position" && e.tags?.bus === "yes",
      ];
      const ALL_TRANSIT_MATCHERS = [...HEAVY_TRANSIT_MATCHERS, ...BUS_MATCHERS];

      // Heavy transit with distances — separate within 800m vs fallback 800-2000m
      const allHeavyTransit = els
        .filter(e => HEAVY_TRANSIT_MATCHERS.some(fn => fn(e)) && e.tags?.name)
        .map(e => {
          const eLat = e.lat ?? e.center?.lat;
          const eLng = e.lon ?? e.center?.lon;
          const dist = (eLat && eLng) ? haversine(lat, lng, eLat, eLng) : 999;
          return { name: e.tags.name, dist };
        })
        .filter((v, i, a) => a.findIndex(x => x.name === v.name) === i); // deduplicate

      const nearestMetro = allHeavyTransit
        .filter(s => s.dist <= 0.8)
        .map(s => s.name);

      const stationCount = nearestMetro.length;

      // For bus-only hoods: 2 closest metro/train stations within 2km with distances
      const nearestMetroFallback = allHeavyTransit
        .filter(s => s.dist > 0.8 && s.dist <= 2.0)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 2)
        .map(s => `${s.name}|${s.dist.toFixed(1)}km`)
        .join(',');

      const busNamesAll = els
        .filter(e => BUS_MATCHERS.some(fn => fn(e)) && e.tags?.name)
        .map(e => e.tags.name)
        .filter((v, i, a) => a.indexOf(v) === i);
      const nearestBus = busNamesAll.slice(0, 4); // names shown in UI
      const busCount   = busNamesAll.length;       // actual count for tile

      // busOnly = bus stops found but no heavy transit within 800m
      const busOnly = nearestMetro.length === 0 && nearestBus.length > 0;

      const coord = e => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, name: e.tags?.name || '' });
      const hasLL = c => c.lat && c.lon;
      const transitCoords     = els.filter(e => ALL_TRANSIT_MATCHERS.some(fn => fn(e))).map(coord).filter(hasLL)
        .filter((v,i,a) => a.findIndex(x => x.name===v.name)===i).slice(0,10);
      // Heavy transit only (metro/tram/train) — no bus stops — for map pins when not busOnly
      const heavyTransitCoords = els.filter(e => HEAVY_TRANSIT_MATCHERS.some(fn => fn(e))).map(coord).filter(hasLL)
        .filter((v,i,a) => a.findIndex(x => x.name===v.name)===i).slice(0,10);
      // Bus stops only — for map pins when busOnly
      const busCoords = els.filter(e => BUS_MATCHERS.some(fn => fn(e))).map(coord).filter(hasLL)
        .filter((v,i,a) => a.findIndex(x => x.name===v.name)===i).slice(0,15);
      const supermarketCoords = els.filter(e => (tags.supermarkets||[]).some(([k,v]) => e.tags?.[k]===v)).map(coord).filter(hasLL).slice(0,10);
      const gymCoords         = els.filter(e => (tags.gyms||[]).some(([k,v]) => e.tags?.[k]===v)).map(coord).filter(hasLL).slice(0,10);
      const museumCoords      = els.filter(e => (tags.museums||[]).some(([k,v]) => e.tags?.[k]===v) && e.tags?.name).map(coord).filter(hasLL).slice(0,15);
      const cafeCoords        = els.filter(e => e.tags?.amenity === "cafe").map(coord).filter(hasLL).slice(0,20);
      const restaurantCoords  = els.filter(e => e.tags?.amenity === "restaurant").map(coord).filter(hasLL).slice(0,40);
      const barCoords         = els.filter(e => ["bar","pub","wine_bar"].includes(e.tags?.amenity)).map(coord).filter(hasLL).slice(0,30);

      // Hybrid counts — run Yelp in parallel, take best of OSM vs Yelp
      Promise.all([
        countHere(lat, lng, HERE_CATEGORIES.restaurants, 600),
        countHere(lat, lng, HERE_CATEGORIES.bars, 600),
        countHere(lat, lng, HERE_CATEGORIES.cafes, 600),
        countHere(lat, lng, HERE_CATEGORIES.gyms, 700),
        countHere(lat, lng, HERE_CATEGORIES.supermarkets, 700),
        countHere(lat, lng, HERE_CATEGORIES.pharmacies, 700),
      ]).then(([yRestaurants, yBars, yCafes, yGyms, ySupermarkets, yPharmacies]) => {
        const best = (osm, yelp) => Math.max(Number(osm) || 0, Number(yelp) || 0);
        console.log(`Foursquare counts — restaurants:${yRestaurants} bars:${yBars} cafes:${yCafes} gyms:${yGyms} supermarkets:${ySupermarkets} pharmacies:${yPharmacies}`);
        resolve({
          pharmacies:   best(pharmacies, yPharmacies),
          supermarkets: best(supermarkets, ySupermarkets),
          parks, gyms: best(gyms, yGyms), intlSchools, museums,
          cinemas, theatres, musicVenues, markets, hospitals,
          restaurants:  best(restaurants, yRestaurants),
          cafes:        best(cafes, yCafes),
          bars:         best(bars, yBars),
          nearestMetro: nearestMetro.slice(0, 4), stationCount, nearestMetroFallback,
          nearestBus, busCount, busOnly,
          transitCoords, heavyTransitCoords, busCoords,
          supermarketCoords, gymCoords, museumCoords, cafeCoords, restaurantCoords, barCoords
        });
      }).catch(() => {
        // HERE failed — fall back to pure OSM counts
        resolve({ pharmacies, supermarkets, parks, gyms, intlSchools, museums,
                  cinemas, theatres, musicVenues, markets, hospitals,
                  restaurants, cafes, bars,
                  nearestMetro: nearestMetro.slice(0, 4), stationCount, nearestMetroFallback,
                  nearestBus, busCount, busOnly,
                  transitCoords, heavyTransitCoords, busCoords,
                  supermarketCoords, gymCoords, museumCoords, cafeCoords, restaurantCoords, barCoords });
      });
    }

    try { processOverpass(rawData); }
    catch(e) { console.error("Overpass parse error:", e.message, rawData?.slice(0,120)); resolve(empty); }
  });
}

// Format Foursquare venue
function formatVenue(venue, city, hoodName) {
  const name = venue.displayName?.text || "Unknown";
  const address = venue.shortFormattedAddress || "";
  const rating = venue.rating ? `${venue.rating.toFixed(1)}★` : "";
  const priceMap = { PRICE_LEVEL_INEXPENSIVE: "€", PRICE_LEVEL_MODERATE: "€€", PRICE_LEVEL_EXPENSIVE: "€€€", PRICE_LEVEL_VERY_EXPENSIVE: "€€€€" };
  const price = priceMap[venue.priceLevel] || "";
  const parts = [address || hoodName, rating, price].filter(Boolean);
  const description = parts.join(' · ') || `In ${hoodName}`;
  const photoRef = venue.photos?.[0]?.name || null;
  const photoUrl = photoRef
    ? `https://places.googleapis.com/v1/${photoRef}/media?maxHeightPx=200&maxWidthPx=300&key=${GOOGLE_PLACES_KEY}`
    : null;
  const isOpen = venue.currentOpeningHours?.openNow;
  const openStatus = isOpen === true ? 'Open now' : isOpen === false ? 'Closed' : null;
  const website = venue.websiteUri || null;
  const primaryType = venue.primaryType || null;
  const lat = venue.location?.latitude || null;
  const lng = venue.location?.longitude || null;
  return { name, description, googleMapsQuery: `${name} ${hoodName} ${city}`, photoUrl, openStatus, website, primaryType, lat, lng };
}

// Fast enrichment — Google Places venues only, no slow Overpass calls
// ── GOOGLE GEOCODING — get coordinates for a named venue ─────────────────────
function geocodeVenue(name, neighbourhood, city) {
  return new Promise((resolve) => {
    const address = encodeURIComponent(`${name}, ${neighbourhood}, ${city}`);
    const req = https.request({
      hostname: 'maps.googleapis.com',
      path: `/maps/api/geocode/json?address=${address}&key=${GOOGLE_PLACES_KEY}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const result = parsed.results?.[0];
          if (!result) return resolve(null);
          resolve({
            lat: result.geometry.location.lat,
            lng: result.geometry.location.lng,
            address: result.formatted_address,
          });
        } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function enrichMatchFast(match, destCity, vibesStr) {
  if (!match.lat || !match.lng) return match;
  try {

    // ── Step 0: Try Supabase pre-curated venues first ──
    // If the matched neighbourhood is seeded, skip Claude venue curation entirely.
    // Falls back transparently to Claude if miss or if Supabase is unavailable.
    const sbVenues = await lookupSupabase(match.name, destCity, vibesStr || "");
    if (sbVenues) {
      match.top3Restaurants = sbVenues.restaurants;
      match.top3Bars        = sbVenues.bars;
      match.top3Cafes       = sbVenues.cafes;
      match._venueSource    = "supabase";
      if (sbVenues.radius_m) match.radius_m = sbVenues.radius_m;
      return match;
    }

    // ── Step 1: Claude curates the best venues from local knowledge ──
    const prompt = `You are an opinionated local expert for ${match.name}, ${destCity}.

Name the most iconic, neighbourhood-defining spots — the kind a well-travelled friend who lives there would recommend. No chains, no tourist traps, nothing generic. Only places that genuinely define the character of ${match.name}.

Return ONLY valid JSON, no markdown:
{
  "restaurants": [
    {"name": "Bodega de la Ardosa", "description": "Standing-room vermouth bar, locals only since 1892", "priceLevel": "€", "website": "https://www.bodegadelaardosa.com"},
    {"name": "...", "description": "...", "priceLevel": "€€", "website": ""}
  ],
  "bars": [
    {"name": "...", "description": "...", "priceLevel": "€", "website": ""}
  ],
  "cafes": [
    {"name": "...", "description": "...", "priceLevel": "€", "website": ""}
  ]
}

Rules:
- restaurants: exactly 5 (or fewer if genuinely fewer iconic options exist)
- bars: exactly 4
- cafes: exactly 3
- description: one punchy line, max 10 words, what makes it special
- priceLevel: €, €€, or €€€
- website: include only if you are confident it is correct and current — otherwise leave as empty string ""
- Only include venues you are confident exist in ${match.name}, ${destCity}`;

    let claudeVenues = null;
    try {
      const text = await callClaude(prompt);
      const cleaned = text.replace(/```json|```/g, '').trim();
      claudeVenues = JSON.parse(cleaned);
    } catch(e) {
      console.error(`Claude curation failed for ${match.name}:`, e.message);
    }

    // ── Step 2: Geocode each venue via Google to get coordinates ──
    const geocodeAll = async (venues, category) => {
      if (!venues?.length) return [];
      const results = await Promise.all(
        venues.map(async (v) => {
          const geo = await geocodeVenue(v.name, match.name, destCity);
          if (!geo) {
            console.log(`Geocode miss: ${v.name} in ${match.name}`);
            return null;
          }
          const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(v.name + ', ' + match.name + ', ' + destCity)}`;
          return {
            name: v.name,
            description: `${v.description}${v.priceLevel ? ' · ' + v.priceLevel : ''}`,
            googleMapsQuery: `${v.name} ${match.name} ${destCity}`,
            photoUrl: null,
            openStatus: null,
            website: v.website || null,
            primaryType: category,
            lat: geo.lat,
            lng: geo.lng,
            mapsUrl,
          };
        })
      );
      return results.filter(Boolean);
    };

    if (claudeVenues) {
      const [restaurants, bars, cafes] = await Promise.all([
        geocodeAll(claudeVenues.restaurants, 'restaurant'),
        geocodeAll(claudeVenues.bars,        'bar'),
        geocodeAll(claudeVenues.cafes,       'cafe'),
      ]);

      match.top3Restaurants = restaurants;
      match.top3Bars        = bars;
      match.top3Cafes       = cafes;

      console.log(`Claude-curated picks for ${match.name}: ${restaurants.length} restaurants, ${bars.length} bars, ${cafes.length} cafes`);
    } else {
      // ── Fallback: Google popularity if Claude fails ──
      const [restaurants, bars, cafes] = await Promise.all([
        searchGoogle(match.lat, match.lng, ["restaurant"], 5),
        searchGoogle(match.lat, match.lng, ["bar", "wine_bar", "pub"], 4),
        searchGoogle(match.lat, match.lng, ["cafe"], 3),
      ]);
      match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity, match.name));
      match.top3Bars        = bars.map(v => formatVenue(v, destCity, match.name));
      match.top3Cafes       = cafes.map(v => formatVenue(v, destCity, match.name));
      console.log(`Fallback Google picks for ${match.name}: ${restaurants.length} restaurants, ${bars.length} bars, ${cafes.length} cafes`);
    }

  } catch (err) {
    console.error("Fast enrichment error for", match.name, err.message);
    match.top3Restaurants = match.top3Restaurants || [];
    match.top3Bars = match.top3Bars || [];
    match.top3Cafes = match.top3Cafes || [];
  }
  return match;
}

// ── OSM TAG MAPPING BY CITY ─────────────────────────────────────────────────
const CITY_TAGS = {
  // Portugal
  "Lisbon": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Porto":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // UK
  "London": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // France
  "Paris":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","subway_entrance"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Spain
  "Barcelona": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Madrid":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Seville":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Netherlands
  "Amsterdam": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Italy
  "Rome":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Florence": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["railway","halt"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Milan":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["railway","subway_entrance"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Germany
  "Berlin":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Munich":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Frankfurt":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Düsseldorf":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Other Europe
  "Vienna":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Copenhagen":{ supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Stockholm": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Prague":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Budapest":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Brussels":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Istanbul":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Americas
  "New York":      { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Los Angeles":   { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "San Francisco": { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Chicago":       { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Miami":         { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Boston":        { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Washington DC": { supermarkets: [["shop","supermarket"],["shop","convenience"],["shop","grocery"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Toronto":       { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Montreal":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Mexico City":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "São Paulo":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Rio de Janeiro":{ supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Buenos Aires":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","plaza"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Asia Pacific
  "Tokyo":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Seoul":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Singapore": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Dubai":     { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Sydney":    { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Melbourne": { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","common"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Bangkok":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Beijing":   { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Shanghai":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["station","subway"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Bali":      { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["amenity","bus_station"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  // Africa & Middle East
  "Cape Town":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["public_transport","stop_position"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["leisure","sports_centre"]], parks: [["leisure","park"],["leisure","nature_reserve"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
  "Marrakech":  { supermarkets: [["shop","supermarket"],["shop","convenience"]], transit: [["railway","station"],["amenity","bus_station"]], schools: [["amenity","school"],["amenity","college"]], gyms: [["leisure","fitness_centre"],["amenity","gym"]], parks: [["leisure","park"],["leisure","garden"]], museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]]},
};

// Default fallback tags for cities not in mapping
const DEFAULT_TAGS = {
  supermarkets: [["shop","supermarket"],["shop","convenience"]],
  transit: [["railway","station"],["railway","subway_entrance"],["station","subway"]],
  schools: [["amenity","school"],["amenity","college"]],
  gyms: [["leisure","fitness_centre"],["amenity","gym"]],
  parks: [["leisure","park"],["leisure","garden"]],
  museums: [["tourism","museum"],["historic","monument"],["historic","castle"],["historic","ruins"]],
};



async function enrichMatch(match, destCity, intent) {
  if (!match.lat || !match.lng) return match;

  try {
    const [restaurants, bars, cafes] = await Promise.all([
      searchGoogle(match.lat, match.lng, ["restaurant"], 3),
      searchGoogle(match.lat, match.lng, ["bar", "wine_bar", "pub"], 3),
      searchGoogle(match.lat, match.lng, ["cafe"], 3),
    ]);

    if (restaurants.length > 0) match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity, match.name));
    if (bars.length > 0) match.top3Bars = bars.map(v => formatVenue(v, destCity, match.name));
    if (cafes.length > 0) match.top3Cafes = cafes.map(v => formatVenue(v, destCity, match.name));

    // ONE batched Overpass call for all amenities + transit
    const amenityData = await fetchAllAmenities(match.lat, match.lng, destCity);

    if (amenityData.nearestMetro.length > 0) match.nearestMetro = amenityData.nearestMetro;
    if (amenityData.nearestBus?.length > 0) match.nearestBus = amenityData.nearestBus;
    if (amenityData.busCount)               match.busCount   = amenityData.busCount;
    if (amenityData.busOnly)                match.busOnly    = true;
    if (amenityData.nearestMetroFallback)   match.nearestMetroFallback = amenityData.nearestMetroFallback;

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
function buildPrompt(safehomeHood, safehomeCity, safedestCity, safeVibes, intent, excludeHoods) {
  // Build rich vibe context — each vibe gets specific guidance for neighbourhood matching
  const VIBE_GUIDANCE = {
    "Wine & Nightlife":       "Prioritise neighbourhoods with a vibrant bar scene, nightclubs, late-night energy. Mention specific bar streets or nightlife clusters in whyItMatches.",
    "Food & Restaurants":     "Prioritise neighbourhoods with exceptional food scenes — markets, acclaimed restaurants, diverse cuisines. Mention specific foodie credentials.",
    "Shopping & Boutiques":   "Prioritise neighbourhoods with independent boutiques, design shops, markets. Flag any famous shopping streets.",
    "Parks & Outdoors":       "Prioritise neighbourhoods near parks, waterfronts, green spaces. Mention walkability and outdoor lifestyle.",
    "Culture & Architecture": "Prioritise neighbourhoods rich in museums, galleries, historic architecture, cultural institutions.",
    "Music & Arts":           "Prioritise neighbourhoods with live music venues, art galleries, creative communities, street art.",
    "Cafés & Chill":          "Prioritise neighbourhoods with excellent café culture, relaxed pace, good spots to work or read.",
    "Family Friendly":        "Prioritise neighbourhoods with good schools, parks, playgrounds, family-oriented amenities, safe streets.",
    "Digital Nomad":          "Prioritise neighbourhoods with excellent cafés/coworking, fast internet reputation, international community.",
    "Off the Beaten Track":   "Avoid the obvious tourist or expat neighbourhoods. Pick something genuinely local, emerging, or alternative — the kind of place most visitors never find. Reflect this boldly in tagline and whyItMatches.",
    "LGBT+ Friendly":         "Prioritise neighbourhoods known for LGBT+ acceptance, community, venues and events. Mention proximity to any known gay villages or LGBT+ hubs. Flag safety for LGBT+ travellers in safetyRating context.",
    "Senior Friendly":        "Prioritise neighbourhoods with flat terrain, excellent public transport, good healthcare access, quieter streets, daytime café culture. Flag any hills or accessibility challenges in cons.",
    "Accessible":             "Prioritise neighbourhoods with flat terrain, good pavement quality, accessible public transport. Flag hills, cobblestones, steps or poor accessibility in cons. Be honest about challenges.",
    "Affordable":             "Prioritise neighbourhoods with budget-friendly options — cheap eats, affordable bars, lower cost of living. Mention specific affordable venues and avoid recommending expensive areas.",
  };
  const vibeList = safeVibes ? safeVibes.split(", ").filter(Boolean) : [];
  const vibeGuidance = vibeList.map(v => VIBE_GUIDANCE[v]).filter(Boolean).join(" ");
  const vibeContext = vibeList.length
    ? "\nThe traveller has selected these preferences: " + safeVibes + ".\n" + vibeGuidance + "\nReflect these preferences throughout the response \u2014 in tagline, whyItMatches, pros, cons, bestFor and top3ThingsToDo."
    : "";
  const excludeContext = Array.isArray(excludeHoods) && excludeHoods.length > 0
    ? `\nDo NOT suggest any of these neighbourhoods — the user has already seen them: ${excludeHoods.map(h => `"${h}"`).join(", ")}. Suggest a genuinely different option.`
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
    "top3ThingsToDo": [
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false}
    ],
    "mustTry": "One iconic food, drink or experience that defines this specific neighbourhood — not just anywhere in ${safedestCity}",
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
    "top3ThingsToDo": [
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": true},
      {"name": "Name", "description": "Short line", "gygQuery": "experience ${safedestCity}", "isPaid": false}
    ],
    "mustTry": "One iconic food, drink or experience that defines this specific neighbourhood — not just ${safedestCity} in general",
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
  const { homeCity, homeHood, destCity, vibes, intent, excludeHoods } = req.body;

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
  const safeExcludeHoods = Array.isArray(excludeHoods)
    ? excludeHoods.map(h => sanitise(String(h))).filter(Boolean)
    : [];
  const currentIntent = intent === "move" ? "move" : "visit";

  try {
    // Step 1: Claude — neighbourhood matches with intent-specific fields
    const prompt = buildPrompt(safehomeHood, safehomeCity, safedestCity, safeVibes, currentIntent, safeExcludeHoods);
    const text = await callClaude(prompt);
    const cleaned = text.replace(/```json|```/g, "").trim();
    let matches = JSON.parse(cleaned);

    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error("Invalid response format");
    }

    // Fast enrichment — single match; passes vibes so Supabase lookup can score by overlap
    matches = await Promise.all(
      matches.map(m => enrichMatchFast(m, safedestCity, safeVibes))
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
        // ONE batched Overpass call — all counts + coords from OSM (accurate, no API cap)
        const amenityData = await fetchAllAmenities(m.lat, m.lng, destCity, m._polygon || null);

        if (amenityData.nearestMetro.length > 0) m.nearestMetro = amenityData.nearestMetro;
        if (amenityData.nearestBus?.length > 0)  m.nearestBus   = amenityData.nearestBus;
        if (amenityData.busCount)                  m.busCount     = amenityData.busCount;
        if (amenityData.busOnly)                   m.busOnly      = true;
        if (amenityData.nearestMetroFallback)      m.nearestMetroFallback = amenityData.nearestMetroFallback;
        if (amenityData.transitCoords?.length)      m.transitCoords      = amenityData.transitCoords;
        if (amenityData.heavyTransitCoords?.length)  m.heavyTransitCoords = amenityData.heavyTransitCoords;
        if (amenityData.busCoords?.length)           m.busCoords          = amenityData.busCoords;
        if (amenityData.supermarketCoords?.length)  m.supermarketCoords  = amenityData.supermarketCoords;
        if (amenityData.gymCoords?.length)          m.gymCoords          = amenityData.gymCoords;
        if (amenityData.museumCoords?.length)       m.museumCoords       = amenityData.museumCoords;
        if (amenityData.cafeCoords?.length)         m.cafeCoords         = amenityData.cafeCoords;
        if (amenityData.restaurantCoords?.length)   m.restaurantCoords   = amenityData.restaurantCoords;
        if (amenityData.barCoords?.length)          m.barCoords          = amenityData.barCoords;

        m.amenities = {
          pharmacies:   amenityData.pharmacies,
          supermarkets: amenityData.supermarkets,
          parks:        amenityData.parks,
          gyms:         amenityData.gyms,
          intlSchools:  amenityData.intlSchools,
          museums:      amenityData.museums,
          restaurants:  amenityData.restaurants,
          cafes:        amenityData.cafes,
          bars:         amenityData.bars,
          musicVenues:  amenityData.musicVenues,
          cinemas:      amenityData.cinemas,
          theatres:     amenityData.theatres,
          markets:      amenityData.markets,
          hospitals:    amenityData.hospitals,
          stations:     amenityData.stationCount || 0,
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


// ── OVERPASS BROWSER PROXY ───────────────────────────────────────────────────
// Browser can't call Overpass directly at scale (rate limits + CORS on some endpoints).
// This proxy forwards park polygon queries from the browser through the server.
app.get("/api/overpass", async (req, res) => {
  const data = req.query.data;
  if (!data) return res.status(400).json({ error: 'Missing data param' });

  const body = 'data=' + data;
  const proxyReq = https.request({
    hostname: 'overpass-api.de',
    path: '/api/interpreter',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (proxyRes) => {
    let result = '';
    proxyRes.on('data', chunk => result += chunk);
    proxyRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(result);
    });
  });
  proxyReq.on('error', (e) => {
    console.error('Overpass proxy error:', e.message);
    res.status(500).json({ error: 'Overpass unavailable' });
  });
  proxyReq.write(body);
  proxyReq.end();
});

app.get("/api/nominatim", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing q param" });
  const decoded = decodeURIComponent(q);
  const path = `/search?q=${encodeURIComponent(decoded)}&format=geojson&polygon_geojson=1&limit=1`;
  const nomReq = https.request({
    hostname: "nominatim.openstreetmap.org", path, method: "GET",
    headers: { "User-Agent": "MatchMyHood/1.0 (matchmyhood.com)", "Accept": "application/json" },
  }, (nomRes) => {
    let data = "";
    nomRes.on("data", chunk => data += chunk);
    nomRes.on("end", () => { res.setHeader("Content-Type","application/json"); res.setHeader("Access-Control-Allow-Origin","*"); res.send(data); });
  });
  nomReq.on("error", (e) => { console.error("Nominatim proxy error:", e.message); res.status(500).json({ error: "Nominatim unavailable" }); });
  nomReq.end();
});

// ── TRANSIT LINES ENDPOINT ───────────────────────────────────────────────────
// Returns real metro/tram/train route geometries from Overpass with name, ref, colour
app.post("/api/transitlines", async (req, res) => {
  const { lat, lng } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  // Use bbox of ~40km around the point to cover the full city
  const delta = 0.35; // ~40km
  const bbox = `${lat - delta},${lng - delta},${lat + delta},${lng + delta}`;

  const query = `
[out:json][timeout:45];
(
  relation["route"~"subway|light_rail|tram|rail"]["type"!="route_master"](${bbox});
);
out geom qt;`;

  const body = `data=${encodeURIComponent(query)}`;

  const MIRRORS = ["overpass-api.de", "z.overpass-api.de", "lz4.overpass-api.de"];

  // Default colour palette for lines without OSM colour tag
  const LINE_COLOURS = ['#E74C3C','#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E67E22','#E91E63'];

  async function tryMirror(hostname) {
    return new Promise((resolve, reject) => {
      const r = https.request({
        hostname, path: "/api/interpreter", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      }, (response) => {
        let d = "";
        response.on("data", chunk => d += chunk);
        response.on("end", () => {
          if (d.trimStart().startsWith("<")) reject(new Error(`${hostname} rate-limited`));
          else resolve(d);
        });
        response.on("error", reject);
      });
      r.on("error", reject);
      r.write(body);
      r.end();
    });
  }

  let rawData = null;
  for (const mirror of MIRRORS) {
    try {
      rawData = await tryMirror(mirror);
      console.log(`Transit lines ${mirror} OK — ${rawData.length} bytes`);
      break;
    } catch(e) {
      console.error(`Transit lines ${mirror} failed: ${e.message}`);
    }
  }

  if (!rawData) return res.json({ lines: [] });

  try {
    const parsed = JSON.parse(rawData);
    const relations = parsed.elements || [];
    const lines = [];
    const refColourMap = {};
    const seenRefs  = new Set(); // deduplicate by ref
    const seenNames = new Set(); // deduplicate by normalised name (for lines without ref)
    let colourIdx = 0;

    // Normalise a line name for dedup — strips direction info
    // "T-bana 13: Norsborg → Ropsten" → "t-bana 13"
    const normaliseName = (name) => name
      .toLowerCase()
      .replace(/[→←↔:].*/g, '')   // strip everything after direction arrows or colon
      .replace(/\s+/g, ' ')
      .trim();

    for (const rel of relations) {
      const name = rel.tags?.name || rel.tags?.ref || 'Transit Line';
      const ref  = rel.tags?.ref || '';

      // Deduplicate by ref first
      if (ref && seenRefs.has(ref)) continue;
      if (ref) seenRefs.add(ref);

      // For lines without ref, deduplicate by normalised name
      if (!ref) {
        const normName = normaliseName(name);
        if (seenNames.has(normName)) continue;
        seenNames.add(normName);
      }

      // Assign colour: OSM colour tag first, then consistent per ref, then palette
      const osmColour = rel.tags?.colour || rel.tags?.color;
      let colour;
      if (osmColour) {
        colour = osmColour;
        if (ref && !refColourMap[ref]) refColourMap[ref] = osmColour;
      } else if (ref && refColourMap[ref]) {
        colour = refColourMap[ref]; // same ref = same colour
      } else {
        colour = LINE_COLOURS[colourIdx % LINE_COLOURS.length];
        if (ref) refColourMap[ref] = colour;
        colourIdx++;
      }

      // Build coordinates from member way geometries
      const coords = [];
      const stops = [];
      for (const member of (rel.members || [])) {
        if (member.type === 'way' && member.geometry?.length) {
          coords.push(member.geometry.map(p => [p.lon, p.lat]));
        }
        if (member.type === 'node' && member.lat && member.lon &&
            (member.role === 'stop' || member.role === 'platform' || member.role === 'stop_entry_only' || member.role === 'stop_exit_only')) {
          stops.push([member.lon, member.lat]);
        }
      }

      if (coords.length > 0) {
        lines.push({ name, ref, colour, coords, stops });
      }
    }

    console.log(`Transit lines parsed: ${relations.length} relations → ${lines.length} lines after processing`);
    return res.json({ lines });
  } catch(e) {
    console.error('Transit lines parse error:', e.message);
    return res.json({ lines: [] });
  }
});

// ── HAVERSINE ────────────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── LANDMARKS ENDPOINT ───────────────────────────────────────────────────────
// Claude generates top 8 must-visit landmarks/experiences for the city,
// with transport advice and distance from the matched neighbourhood centre.
app.post("/api/landmarks", async (req, res) => {
  const { city, neighbourhood, lat, lng, vibes } = req.body;
  if (!city || !neighbourhood || !lat || !lng) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const vibeContext = Array.isArray(vibes) && vibes.length
    ? `

The traveller has selected these interests: ${vibes.join(', ')}. Weight your picks accordingly — e.g. for "Wine & Nightlife" lean toward great bars, clubs and late-night scenes; for "Food & Restaurants" include iconic food markets and must-eat spots; for "Music & Arts" include live music venues and galleries; for "Parks & Outdoors" include the best green spaces and walks. Still include 2-3 unmissable iconic sights regardless of vibes.`
    : '';

  const prompt = `You are an opinionated, well-travelled city expert writing for a savvy traveller staying in ${neighbourhood}, ${city}.${vibeContext}

Create the definitive "8 things you must do in ${city}" list — the kind a brilliant local friend would give you. This means:
- The truly iconic sights that define the city (even if obvious — if Big Ben defines London, include it; if Sagrada Família defines Barcelona, it leads the list)
- Unmissable experiences: world-famous markets, shows, food scenes, viewpoints, neighbourhoods to walk
- Cultural gems: great museums, architectural wonders, historic quarters
- One genuinely local secret that most tourists miss

Be bold and specific. "See a West End show" is valid. "Walk Notting Hill on market day" is valid. "Eat at Noma" is valid. Don't be conservative — include what the city is genuinely famous for, not just safe picks.

For each, give the realistic travel time from ${neighbourhood} (centre: ${lat}, ${lng}).

Respond ONLY with a valid JSON array, no markdown:
[
  {
    "name": "Sagrada Família",
    "why": "Gaudí's century-in-the-making basilica — the most visited site in Spain for good reason",
    "distanceKm": 2.1,
    "transport": "metro",
    "transportLine": "L5 (Sagrada Família stop)",
    "minutes": 10,
    "bookInAdvance": true,
    "tip": "Book online — queues without tickets can be 2 hours"
  }
]

Rules:
- distanceKm = straight-line km from ${neighbourhood} centre, 1 decimal place
- transport = one of: "walk", "metro", "bus", "tram", "train", "taxi"
- transportLine = specific line/route if applicable, else ""
- minutes = realistic door-to-door time as integer
- bookInAdvance = true if tickets/reservations strongly recommended
- tip = one punchy practical tip (max 15 words), or "" if none
- DO NOT omit the city's most iconic sight just because it's well-known
- Include at least one unmissable experience (market, show, food scene, walk)
- Include one genuinely local hidden gem as the last item
- Order by must-see priority
- 8 items exactly`;

  try {
    const text = await callClaude(prompt);
    const cleaned = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    const landmarks = JSON.parse(cleaned);
    if (!Array.isArray(landmarks)) throw new Error('Invalid format');
    return res.json({ landmarks });
  } catch (err) {
    console.error('Landmarks error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


// ── HOOD POLYGON ENDPOINT ───────────────────────────────────────────────────
// Returns the neighbourhood polygon from Supabase as GeoJSON Feature.
// Called by the frontend map instead of Nominatim for seeded cities.
app.get("/api/hood-polygon", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { name, city } = req.query;
  if (!name || !city) return res.status(400).json({ error: "Missing name or city" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(503).json({ error: "Supabase not configured" });

  try {
    // PostgREST doesn't support ST_AsGeoJSON in .select() so we use a raw SQL call
    // via the Supabase REST /rest/v1/rpc endpoint with a custom SQL function
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ error: "Supabase not configured" });

    const { data: rows, error } = await sb
      .rpc("get_hood_geojson", { p_name: name, p_city: city });

    if (error || !rows || rows.length === 0 || !rows[0].geom_json) {
      console.log(`Hood polygon not found: ${name}, ${city}`, error?.message);
      return res.status(404).json({ error: "Polygon not found" });
    }

    const geometry = JSON.parse(rows[0].geom_json);
    const feature = {
      type: "Feature",
      geometry,
      properties: { name: rows[0].name, city: rows[0].city }
    };
    return res.json(feature);
  } catch (err) {
    console.error("Hood polygon error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── PHOTO PROXY ─────────────────────────────────────────────────────────────
// Proxies Google Places photos server-side to avoid 403 browser blocks.
// Frontend uses /api/photo?ref=PHOTO_REFERENCE instead of direct Google URL.
app.get("/api/photo", async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).send("Missing ref");

  const googleUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${encodeURIComponent(ref)}&key=${GOOGLE_PLACES_KEY}`;

  try {
    await new Promise((resolve, reject) => {
      const request = https.request(googleUrl, (googleRes) => {
        // Google responds with 302 redirect — follow it
        if (googleRes.statusCode === 302 || googleRes.statusCode === 301) {
          const redirectUrl = googleRes.headers.location;
          if (!redirectUrl) { res.status(502).send("No redirect"); return resolve(); }

          https.get(redirectUrl, (imgRes) => {
            res.setHeader("Content-Type", imgRes.headers["content-type"] || "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.setHeader("Access-Control-Allow-Origin", "*");
            imgRes.pipe(res);
            imgRes.on("end", resolve);
            imgRes.on("error", reject);
          }).on("error", reject);
        } else if (googleRes.statusCode === 200) {
          res.setHeader("Content-Type", googleRes.headers["content-type"] || "image/jpeg");
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.setHeader("Access-Control-Allow-Origin", "*");
          googleRes.pipe(res);
          googleRes.on("end", resolve);
          googleRes.on("error", reject);
        } else {
          res.status(googleRes.statusCode).send("Photo unavailable");
          resolve();
        }
      });
      request.on("error", reject);
      request.end();
    });
  } catch (err) {
    console.error("Photo proxy error:", err.message);
    if (!res.headersSent) res.status(502).send("Photo proxy error");
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CITY GUIDES API
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/city-guide/:city — all hoods for a city with guide fields
app.get("/api/city-guide/:city", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const city = req.params.city.toLowerCase();
  try {
    const { data, error } = await sb
      .from("neighbourhoods")
      .select("id, name, slug, city, description, lat, lng, radius_m, guide_description, best_time, walking_radius, hill_warning")
      .ilike("city", `%${city}%`)
      .order("name");

    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "City not found" });

    const hoodIds = data.map(h => h.id);
    const { data: venueCounts } = await sb
      .from("venues")
      .select("neighbourhood_id")
      .in("neighbourhood_id", hoodIds);

    const countMap = {};
    (venueCounts || []).forEach(v => {
      countMap[v.neighbourhood_id] = (countMap[v.neighbourhood_id] || 0) + 1;
    });

    const hoods = data.map(h => ({
      ...h,
      venue_count: countMap[h.id] || 0
    }));

    res.json({ city, hoods, total_venues: Object.values(countMap).reduce((a, b) => a + b, 0) });
  } catch (err) {
    console.error("city-guide error:", err.message);
    res.status(500).json({ error: "Failed to load city guide" });
  }
});

// GET /api/hood-guide/:slug — full hood data (venues, moments, walks, tips)
app.get("/api/hood-guide/:slug", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const slug = req.params.slug;
  try {
    const { data: hood, error: hoodErr } = await sb
      .from("neighbourhoods")
      .select("*")
      .eq("slug", slug)
      .single();

    if (hoodErr || !hood) return res.status(404).json({ error: "Neighbourhood not found" });

    const { data: venues } = await sb
      .from("venues")
      .select("id, name, type, description, price_level, lat, lng, website, photo_url, is_brunch, brunch_mood, opening_hours, reservation_tip, skip_reason, editorial_pick, editorial_note, is_subscriber_only")
      .eq("neighbourhood_id", hood.id)
      .order("editorial_pick", { ascending: false })
      .order("name");

    const venueIds = (venues || []).map(v => v.id);
    const { data: vibes } = venueIds.length > 0
      ? await sb.from("venue_vibes").select("venue_id, vibe_tag").in("venue_id", venueIds)
      : { data: [] };

    const vibeMap = {};
    (vibes || []).forEach(v => {
      if (!vibeMap[v.venue_id]) vibeMap[v.venue_id] = [];
      vibeMap[v.venue_id].push(v.vibe_tag);
    });

    const venuesWithVibes = (venues || []).map(v => ({
      ...v,
      vibes: vibeMap[v.id] || []
    }));

    const { data: moments } = await sb
      .from("moments")
      .select("*")
      .eq("neighbourhood_id", hood.id)
      .eq("is_active", true)
      .order("sort_order");

    const { data: walks } = await sb
      .from("hood_walks")
      .select("id, slug, title, description, duration_minutes, best_time, difficulty, sort_order")
      .eq("neighbourhood_id", hood.id)
      .eq("is_active", true)
      .order("sort_order");

    const { data: tips } = await sb
      .from("hood_tips")
      .select("*")
      .eq("neighbourhood_id", hood.id)
      .eq("is_active", true)
      .order("sort_order");

    const restaurants = venuesWithVibes.filter(v => v.type === "restaurant");
    const bars = venuesWithVibes.filter(v => v.type === "bar");
    const cafes = venuesWithVibes.filter(v => v.type === "cafe");
    const brunch = venuesWithVibes.filter(v => v.is_brunch);

    res.json({
      hood: {
        id: hood.id, name: hood.name, slug: hood.slug, city: hood.city,
        description: hood.description, guide_description: hood.guide_description,
        lat: hood.lat, lng: hood.lng, radius_m: hood.radius_m,
        best_time: hood.best_time, walking_radius: hood.walking_radius,
        hill_warning: hood.hill_warning
      },
      venues: { restaurants, bars, cafes, brunch, total: venuesWithVibes.length },
      moments: moments || [],
      walks: walks || [],
      tips: tips || []
    });
  } catch (err) {
    console.error("hood-guide error:", err.message);
    res.status(500).json({ error: "Failed to load hood guide" });
  }
});

// GET /api/hood-walk/:walkId — walk details with all stops
app.get("/api/hood-walk/:walkId", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  try {
    const { data: walk, error: walkErr } = await sb
      .from("hood_walks")
      .select("*")
      .eq("id", req.params.walkId)
      .single();

    if (walkErr || !walk) return res.status(404).json({ error: "Walk not found" });

    const { data: stops } = await sb
      .from("walk_stops")
      .select("*")
      .eq("walk_id", walk.id)
      .order("stop_order");

    res.json({ walk, stops: stops || [] });
  } catch (err) {
    console.error("hood-walk error:", err.message);
    res.status(500).json({ error: "Failed to load walk" });
  }
});

// GET /api/this-week/:city — current week events
app.get("/api/this-week/:city", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const city = req.params.city.toLowerCase();
  const eventType = req.query.type || null;

  try {
    let query = sb
      .from("city_events")
      .select("*")
      .ilike("city", `%${city}%`)
      .gte("date_start", new Date().toISOString().split("T")[0])
      .lte("date_start", new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0])
      .eq("is_active", true)
      .order("date_start")
      .order("time_start");

    if (eventType) query = query.eq("event_type", eventType);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ city, week_of: new Date().toISOString().split("T")[0], events: data || [] });
  } catch (err) {
    console.error("this-week error:", err.message);
    res.status(500).json({ error: "Failed to load events" });
  }
});

// POST /api/ask-mmh — AI assistant powered by Supabase data + Claude knowledge
app.post("/api/ask-mmh", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "Database not configured" });

  const { question, hood_slug } = req.body;
  if (!question || !hood_slug) {
    return res.status(400).json({ error: "question and hood_slug required" });
  }

  try {
    const { data: hood } = await sb
      .from("neighbourhoods")
      .select("id, name, city, description, guide_description, best_time, walking_radius, hill_warning")
      .eq("slug", hood_slug)
      .single();

    if (!hood) return res.status(404).json({ error: "Neighbourhood not found" });

    const { data: venues } = await sb
      .from("venues")
      .select("name, type, description, price_level, website, is_brunch, brunch_mood, opening_hours, reservation_tip, skip_reason, editorial_pick, editorial_note")
      .eq("neighbourhood_id", hood.id)
      .order("editorial_pick", { ascending: false })
      .order("name");

    const { data: tips } = await sb
      .from("hood_tips")
      .select("tip_type, title, content")
      .eq("neighbourhood_id", hood.id)
      .eq("is_active", true);

    const venueLines = (venues || []).map(v => {
      const flags = [];
      if (v.editorial_pick) flags.push("EDITORIAL PICK");
      if (v.is_brunch) flags.push(`brunch:${v.brunch_mood || "yes"}`);
      if (v.skip_reason) flags.push(`SKIP: ${v.skip_reason}`);
      const price = v.price_level === 1 ? "\u20AC" : v.price_level === 2 ? "\u20AC\u20AC" : v.price_level === 3 ? "\u20AC\u20AC\u20AC" : "";
      return `- ${v.name} (${v.type}) ${price} ${flags.join(" | ")}${v.description ? " \u2014 " + v.description : ""}${v.opening_hours ? " Hours: " + v.opening_hours : ""}${v.reservation_tip ? " Booking: " + v.reservation_tip : ""}`;
    }).join("\n");

    const tipLines = (tips || []).map(t => `- [${t.tip_type.toUpperCase()}] ${t.title || ""}: ${t.content}`).join("\n");

    const systemPrompt = `You are the MatchMyHood city guide assistant for ${hood.name}, ${hood.city}. You speak as a knowledgeable local friend \u2014 opinionated, warm, and specific. Never generic. Always give concrete venue names, streets, prices, and practical tips.

NEIGHBOURHOOD: ${hood.name}
${hood.guide_description || hood.description || ""}
Best time: ${hood.best_time || "N/A"}
Walking radius: ${hood.walking_radius || "N/A"}
Hill warning: ${hood.hill_warning || "None"}

VENUES:
${venueLines}

LOCAL TIPS:
${tipLines}

Rules:
- Always recommend from the venue list above. Never invent venues.
- If a venue has SKIP marked, warn the user away from it.
- Prioritise EDITORIAL PICK venues when they match the question.
- Be honest about prices, queues, and tourist traps.
- Keep answers concise \u2014 2-4 sentences max unless asked for detail.
- If you don't know something specific (like today's hours), say so rather than guess.`;

    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: question }],
    });

    const answer = await new Promise((resolve, reject) => {
      const apiReq = https.request({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(requestBody),
        },
      }, (apiRes) => {
        let data = "";
        apiRes.on("data", chunk => data += chunk);
        apiRes.on("end", () => {
          if (apiRes.statusCode !== 200) {
            reject(new Error("Claude API error: " + apiRes.statusCode + " " + data));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content[0].text.trim());
          } catch (e) {
            reject(new Error("Failed to parse Claude response"));
          }
        });
        apiRes.on("error", reject);
      });
      apiReq.on("error", reject);
      apiReq.write(requestBody);
      apiReq.end();
    });

    res.json({ hood: hood.name, question, answer });
  } catch (err) {
    console.error("ask-mmh error:", err.message);
    res.status(500).json({ error: "Failed to get answer" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MatchMyHood API running on port ${PORT}`));
