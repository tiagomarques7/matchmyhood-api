const https = require("https");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const FOURSQUARE_KEY = process.env.FOURSQUARE_KEY || "244GKZ3SYN0QA4CMYR4VXURO3PLM00MUWHAXLJUV04UE05T1";

// Call Claude API
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

// Search Foursquare for venues near a location
function searchFoursquare(lat, lng, query, categories, limit = 3) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      ll: `${lat},${lng}`,
      query: query,
      categories: categories,
      radius: 600, // 600m radius — keeps it within the neighbourhood
      limit: limit,
      sort: "RELEVANCE",
      fields: "name,location,rating,categories,website"
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

// Format Foursquare venue into our format
function formatVenue(venue, city) {
  const name = venue.name || "Unknown";
  const address = venue.location?.formatted_address || venue.location?.address || "";
  const rating = venue.rating ? ` · ${venue.rating}/10` : "";
  const description = address ? `${address}${rating}` : `Local favourite${rating}`;
  return {
    name,
    description,
    googleMapsQuery: `${name} ${city}`
  };
}

// Enrich neighbourhood matches with real Foursquare venues
async function enrichWithFoursquare(matches, destCity) {
  const enriched = await Promise.all(matches.map(async (match) => {
    if (!match.lat || !match.lng) return match;

    try {
      // Get restaurants (category 13000 = Food)
      const restaurants = await searchFoursquare(
        match.lat, match.lng,
        "restaurant", "13000", 3
      );

      // Get bars and wine bars (category 13003 = Bar, 13062 = Wine Bar)
      const bars = await searchFoursquare(
        match.lat, match.lng,
        "wine bar", "13003,13062", 3
      );

      // Only replace if Foursquare returned results
      if (restaurants.length > 0) {
        match.top3Restaurants = restaurants.map(v => formatVenue(v, destCity));
      }
      if (bars.length > 0) {
        match.top3WineBars = bars.map(v => formatVenue(v, destCity));
      }

    } catch (err) {
      console.error("Foursquare error for", match.name, err.message);
      // Keep Claude's results if Foursquare fails
    }

    return match;
  }));

  return enriched;
}

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
  const safeIntent = intent === "move" ? "relocating long-term" : "visiting as a traveller";

  const vibeContext = safeVibes
    ? `\nThe traveller especially values: ${safeVibes}. Weight these dimensions more heavily in your matching.`
    : "";
  const intentContext = intent === "move"
    ? "\nThis person is RELOCATING — emphasise cost, community feel, daily life amenities, and long-term liveability."
    : "\nThis person is VISITING — emphasise walkability, food scene, nightlife, and things to do.";

  const prompt = `You are MatchMyHood, an expert neighbourhood matching tool.

A person loves "${safehomeHood}" in ${safehomeCity}. They are ${safeIntent} to ${safedestCity}.${vibeContext}${intentContext}

Find the TOP 3 matching neighbourhoods in ${safedestCity} based on character, energy, food scene, nightlife, and price point.

CRITICAL RULES:
- Neighbourhoods must genuinely exist in ${safedestCity}
- Match character genuinely — gritty creative = gritty creative, not polished riverside
- lat/lng must be the EXACT neighbourhood centre coordinates, not the city centre — this is used to find real venues nearby

Respond ONLY with a valid JSON array, no markdown:
[
  {
    "name": "Neighbourhood Name",
    "city": "${safedestCity}",
    "matchScore": 92,
    "tagline": "One evocative sentence",
    "whyItMatches": "2 sentences explaining exactly why this matches ${safehomeHood}.",
    "vibes": ["tag1", "tag2", "tag3"],
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
    "walkScore": "High",
    "costLevel": "Mid-range",
    "bestFor": "One short sentence",
    "unsplashQuery": "3-4 word photo query",
    "lat": 41.1234,
    "lng": -8.6789
  }
]

Rules: 3 results, descending scores (88-96%, 82-91%, 78-88%), JSON only, lat/lng = exact neighbourhood centre.`;

  try {
    // Step 1: Get neighbourhood matches from Claude
    const text = await callClaude(prompt);
    const cleaned = text.replace(/```json|```/g, "").trim();
    let matches = JSON.parse(cleaned);

    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error("Invalid response format");
    }

    // Step 2: Enrich with real Foursquare venue data
    matches = await enrichWithFoursquare(matches, destCity);

    return res.json({ matches });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MatchMyHood API running on port ${PORT}`));
