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
      sort: "RATING",
      fields: "name,location,rating,price,categories"
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


// Count venues via Foursquare — used for commercial amenity counts
// More accurate than OSM for restaurants, bars, coffee, gyms, attractions
function countFoursquare(lat, lng, categories, radius = 600) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      ll: `${lat},${lng}`,
      categories: categories,
      radius: radius,
      limit: 50,
      fields: 'fsq_id,name,geocodes'
    });
    const req = https.request({
      hostname: 'api.foursquare.com',
      path: `/v3/places/search?${params.toString()}`,
      method: 'GET',
      headers: { 'Authorization': FOURSQUARE_KEY, 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve((JSON.parse(data).results || []).length); }
        catch { resolve(0); }
      });
      res.on('error', () => resolve(0));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}
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
      `nwr["railway"="station"](around:800,${lat},${lng});`,
      `node["railway"="subway_entrance"](around:800,${lat},${lng});`,
      `node["railway"="tram_stop"](around:800,${lat},${lng});`,
      `node["railway"="halt"](around:800,${lat},${lng});`,
      `nwr["station"="subway"](around:800,${lat},${lng});`,
      `node["public_transport"="stop_position"]["tram"="yes"](around:800,${lat},${lng});`,
      `node["public_transport"="stop_position"]["subway"="yes"](around:800,${lat},${lng});`,
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

      const nearestMetro = els
        .filter(e => HEAVY_TRANSIT_MATCHERS.some(fn => fn(e)) && e.tags?.name)
        .map(e => e.tags.name)
        .filter((v, i, a) => a.indexOf(v) === i);

      const stationCount = nearestMetro.length; // total unique stations — used for amenity tile

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
      const supermarketCoords = els.filter(e => (tags.supermarkets||[]).some(([k,v]) => e.tags?.[k]===v)).map(coord).filter(hasLL).slice(0,10);
      const gymCoords         = els.filter(e => (tags.gyms||[]).some(([k,v]) => e.tags?.[k]===v)).map(coord).filter(hasLL).slice(0,10);
      const museumCoords      = els.filter(e => (tags.museums||[]).some(([k,v]) => e.tags?.[k]===v) && e.tags?.name).map(coord).filter(hasLL).slice(0,15);
      const cafeCoords        = els.filter(e => e.tags?.amenity === "cafe").map(coord).filter(hasLL).slice(0,20);
      const restaurantCoords  = els.filter(e => e.tags?.amenity === "restaurant").map(coord).filter(hasLL).slice(0,40);
      const barCoords         = els.filter(e => ["bar","pub","wine_bar"].includes(e.tags?.amenity)).map(coord).filter(hasLL).slice(0,30);

      resolve({ pharmacies, supermarkets, parks, gyms, intlSchools, museums,
                cinemas, theatres, musicVenues, markets, hospitals,
                restaurants, cafes, bars,
                nearestMetro: nearestMetro.slice(0, 4), stationCount,
                nearestBus, busCount, busOnly,
                transitCoords, supermarketCoords, gymCoords, museumCoords, cafeCoords, restaurantCoords, barCoords });
    }

    try { processOverpass(rawData); }
    catch(e) { console.error("Overpass parse error:", e.message, rawData?.slice(0,120)); resolve(empty); }
  });
}

// Format Foursquare venue
function formatVenue(venue, city, hoodName) {
  const name = venue.name || "Unknown";
  const address = venue.location?.address || venue.location?.formatted_address || "";
  const rating = venue.rating ? `${(venue.rating/2).toFixed(1)}★` : "";
  const price = venue.price ? '€'.repeat(venue.price) : "";
  const parts = [address || hoodName, rating, price].filter(Boolean);
  const description = parts.join(' · ') || `In ${hoodName}`;
  return { name, description, googleMapsQuery: `${name} ${hoodName} ${city}` };
}

// Fast enrichment — Foursquare venues only, no slow Overpass calls
async function enrichMatchFast(match, destCity) {
  if (!match.lat || !match.lng) return match;
  try {
    const [restaurants, bars] = await Promise.all([
      searchFoursquare(match.lat, match.lng, "restaurant", "13000", 3),
      searchFoursquare(match.lat, match.lng, "wine bar", "13003,13062", 3),
    ]);
    if (restaurants.length > 0) match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity, match.name));
    else match.top3Restaurants = [];
    if (bars.length > 0) match.top3WineBars = bars.map(v => formatVenue(v, destCity, match.name));
    else match.top3WineBars = [];
  } catch (err) {
    console.error("Fast enrichment error for", match.name, err.message);
    match.top3Restaurants = match.top3Restaurants || [];
    match.top3WineBars = match.top3WineBars || [];
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
    const [restaurants, bars] = await Promise.all([
      searchFoursquare(match.lat, match.lng, "restaurant", "13000", 3),
      searchFoursquare(match.lat, match.lng, "wine bar", "13003,13062", 3),
    ]);

    if (restaurants.length > 0) match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity, match.name));
    if (bars.length > 0) match.top3WineBars = bars.map(v => formatVenue(v, destCity, match.name));

    // ONE batched Overpass call for all amenities + transit
    const amenityData = await fetchAllAmenities(match.lat, match.lng, destCity);

    if (amenityData.nearestMetro.length > 0) match.nearestMetro = amenityData.nearestMetro;
    if (amenityData.nearestBus?.length > 0) match.nearestBus = amenityData.nearestBus;
    if (amenityData.busCount)               match.busCount   = amenityData.busCount;
    if (amenityData.busOnly)                match.busOnly    = true;

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
  const vibeContext = safeVibes
    ? `\nThe traveller especially values: ${safeVibes}. Weight these heavily.`
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
        // ONE batched Overpass call (civic: parks, stations, pharmacies, supermarkets, schools)
        // + Foursquare counts (commercial: restaurants, bars, coffee, gyms, attractions)
        const [amenityData, fsqRestaurants, fsqBars, fsqCoffee, fsqGyms, fsqAttractions, fsqMusic, fsqCinema, fsqTheatre, fsqMarkets] = await Promise.all([
          fetchAllAmenities(m.lat, m.lng, destCity, m._polygon || null),
          countFoursquare(m.lat, m.lng, '13065', 600),       // Food
          countFoursquare(m.lat, m.lng, '13003,13062', 600), // Bar + Pub
          countFoursquare(m.lat, m.lng, '13035', 600),       // Coffee Shop
          countFoursquare(m.lat, m.lng, '18011', 600),       // Gym/Fitness
          countFoursquare(m.lat, m.lng, '10027,16032', 600), // Museum + Monument/Landmark
          countFoursquare(m.lat, m.lng, '10032,10012', 800), // Music venue + Nightclub
          countFoursquare(m.lat, m.lng, '10024', 1000),      // Cinema
          countFoursquare(m.lat, m.lng, '10048', 1000),      // Theatre/Performing arts
          countFoursquare(m.lat, m.lng, '12061', 1000),      // Food market
        ]);

        if (amenityData.nearestMetro.length > 0) m.nearestMetro = amenityData.nearestMetro;
        if (amenityData.nearestBus?.length > 0)  m.nearestBus   = amenityData.nearestBus;
        if (amenityData.busCount)                  m.busCount     = amenityData.busCount;
        if (amenityData.busOnly)                   m.busOnly      = true;
        if (amenityData.transitCoords?.length)     m.transitCoords     = amenityData.transitCoords;
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
          gyms:         fsqGyms || amenityData.gyms,
          intlSchools:  amenityData.intlSchools,
          museums:      fsqAttractions || amenityData.museums,
          restaurants:  fsqRestaurants || amenityData.restaurants,
          cafes:        fsqCoffee || amenityData.cafes,
          bars:         fsqBars || amenityData.bars,
          musicVenues:  fsqMusic || amenityData.musicVenues,
          cinemas:      fsqCinema || amenityData.cinemas,
          theatres:     fsqTheatre || amenityData.theatres,
          markets:      fsqMarkets || amenityData.markets,
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
  relation["route"~"subway|light_rail|tram"]["type"!="route_master"](${bbox});
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

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MatchMyHood API running on port ${PORT}`));
