const https = require("https");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

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
- Every restaurant and bar MUST be physically inside that specific neighbourhood — not elsewhere in the city. If unsure, omit it. Accuracy over completeness.
- Match character genuinely — gritty creative = gritty creative, not polished riverside
- lat/lng must be the neighbourhood centre coordinates, not the city centre

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

Rules: 3 results, descending scores (88-96%, 82-91%, 78-88%), JSON only, real venues inside the neighbourhood, lat/lng = neighbourhood centre.`;

  try {
    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    });

    const claudeResponse = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(requestBody),
        },
      }, (response) => {
        let data = "";
        response.on("data", chunk => data += chunk);
        response.on("end", () => resolve({ status: response.statusCode, body: data }));
      });
      request.on("error", reject);
      request.write(requestBody);
      request.end();
    });

    if (claudeResponse.status !== 200) {
      console.error("Claude API error:", claudeResponse.status, claudeResponse.body);
      return res.status(502).json({ error: "Claude API error: " + claudeResponse.status });
    }

    const data = JSON.parse(claudeResponse.body);
    const text = data.content[0].text.trim();

    let matches;
    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      matches = JSON.parse(cleaned);
      if (!Array.isArray(matches) || matches.length === 0) throw new Error("Invalid format");
    } catch {
      console.error("Parse error:", text);
      return res.status(502).json({ error: "Could not parse results. Please try again." });
    }

    return res.status(200).json({ matches });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MatchMyHood API running on port ${PORT}`));
