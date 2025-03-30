require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const port = process.env.PORT || 5001;

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));

const HF_API_TOKEN = process.env.HF_API_TOKEN;
const SENTIMENT_URL = "https://api-inference.huggingface.co/models/distilbert-base-uncased-finetuned-sst-2-english";
const TEXT_GEN_URL = "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2";
const AI_HORDE_API_KEY = process.env.AI_HORDE_API_KEY;
const AI_HORDE_IMAGE_URL = "https://stablehorde.net/api/v2/generate/async";
const AI_HORDE_IMAGE_STATUS_URL = "https://stablehorde.net/api/v2/generate/check";
const UNSPLASH_API_KEY = process.env.UNSPLASH_API_KEY;
const UNSPLASH_URL = "https://api.unsplash.com/search/photos";

async function analyzeMood(prompt) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(SENTIMENT_URL, { inputs: prompt }, {
        headers: { Authorization: `Bearer ${HF_API_TOKEN}`, "Content-Type": "application/json" },
      });
      console.log("Sentiment Response:", response.data);
      const sentiments = response.data[0];
      if (!Array.isArray(sentiments) || sentiments.length === 0) throw new Error("Invalid sentiment response");
      const winningSentiment = sentiments.reduce((prev, current) => prev.score > current.score ? prev : current);
      const mood = winningSentiment.label === "POSITIVE" ? "Positive" : "Negative";
      const intensity = Math.round(winningSentiment.score * 100);
      return { mood, intensity };
    } catch (error) {
      console.error(`Mood Analysis Error (Attempt ${attempt}):`, error.message);
      if (attempt === 3 || error.response?.status !== 503) {
        return { mood: "Neutral", intensity: 50 };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function generateImage(prompt, mood) {
  try {
    console.log("Starting image generation for:", `${prompt}, ${mood} mood`);
    const response = await axios.post(AI_HORDE_IMAGE_URL, {
      prompt: `${prompt}, ${mood} mood`,
      params: { sampler_name: "k_euler_a", steps: 20, cfg_scale: 7.5, width: 512, height: 512 },
    }, {
      headers: { "apikey": AI_HORDE_API_KEY, "Content-Type": "application/json" },
    });
    const jobId = response.data.id;
    console.log("Image Job ID:", jobId);

    let imageUrl = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const status = await axios.get(`${AI_HORDE_IMAGE_STATUS_URL}/${jobId}`);
      console.log(`Image Status ${i + 1}:`, status.data);
      if (status.data.done) {
        const result = await axios.get(`https://stablehorde.net/api/v2/generate/status/${jobId}`);
        console.log("Image Result:", result.data);
        imageUrl = result.data.generations[0].img;
        break;
      }
    }
    if (!imageUrl) throw new Error("Image generation timed out");
    return imageUrl;
  } catch (error) {
    console.error("AI Horde Image Error:", error.message, error.response?.data);
    return "https://images.unsplash.com/photo-1504608524841-42fe6f032b4b";
  }
}

async function fetchRecommendationImage(query) {
  try {
    const response = await axios.get(UNSPLASH_URL, {
      params: { query, per_page: 1, orientation: "landscape" },
      headers: { Authorization: `Client-ID ${UNSPLASH_API_KEY}` },
    });
    return response.data.results[0]?.urls.small || "https://images.unsplash.com/photo-1506748686214-e9df14d4d9d0";
  } catch (error) {
    console.error("Unsplash Image Error:", error.message);
    return "https://images.unsplash.com/photo-1506748686214-e9df14d4d9d0";
  }
}

async function generateRecommendations(prompt, mood, city) {
  try {
    const recPrompt = `[INST] Return only a valid JSON object for "${prompt}" with a ${mood} mood in ${city || "any city"}: a soothing soundtrack (valid, existing YouTube URL of a real video), a book, a movie, a TV show, a podcast, a food item, an activity, a game, a quote (text only, optionally with author), plus a short mood explanation (20-30 words), and 3 local events (name, date, link). For each recommendation except quote, include a "link" (URL), ensuring the "music" link is a real, accessible YouTube video URL (e.g., "https://www.youtube.com/watch?v=VALID_ID"). Format: {"music": {"value": "", "link": ""}, "book": {"value": "", "link": ""}, "movie": {"value": "", "link": ""}, "tv": {"value": "", "link": ""}, "podcast": {"value": "", "link": ""}, "food": {"value": "", "link": ""}, "activity": {"value": "", "link": ""}, "game": {"value": "", "link": ""}, "quote": {"value": "", "author": ""}, "moodExplanation": "", "localEvents": [{"name": "", "date": "", "link": ""}, ...]} [/INST]`;
    console.log("Starting text generation for:", recPrompt);

    const response = await axios.post(TEXT_GEN_URL, {
      inputs: recPrompt,
      parameters: { max_length: 600, temperature: 0.7, return_full_text: false },
    }, {
      headers: { Authorization: `Bearer ${HF_API_TOKEN}`, "Content-Type": "application/json" },
    });

    console.log("Raw HF Text Response:", response.data);
    let output = response.data[0].generated_text.trim();
    console.log("Generated Text:", output);

    output = output.replace(/```json\n?|\n?```/g, "").trim();
    let textResult = JSON.parse(output);

    if (!textResult.quote) {
      textResult.quote = { value: "Every day is a new adventure.", author: "Unknown" };
    }

    const recommendationsWithImages = {};
    for (const [key, rec] of Object.entries(textResult)) {
      if (key === "quote" || key === "moodExplanation" || key === "localEvents") {
        recommendationsWithImages[key] = rec;
      } else {
        const imageUrl = await fetchRecommendationImage(rec.value);
        recommendationsWithImages[key] = { ...rec, imageUrl };
      }
    }

    return recommendationsWithImages;
  } catch (error) {
    console.error("HF Text Generation Error:", error.message, error.response?.data);
    return {
      music: { value: "Lo-Fi Chill Beats", link: "https://www.youtube.com/watch?v=5qap5aO4i9A" },
      book: { value: "The Great Gatsby by F. Scott Fitzgerald", link: "https://www.goodreads.com/book/show/4671.The_Great_Gatsby" },
      movie: { value: "Drive", link: "https://www.imdb.com/title/tt0780504/" },
      tv: { value: "Top Gear", link: "https://www.imdb.com/title/tt1628033/" },
      podcast: { value: "The Car Show", link: "https://www.npr.org/podcasts/510208/car-talk" },
      food: { value: "Chicken Pot Pie", link: "https://www.allrecipes.com/recipe/26317/chicken-pot-pie-ix/" },
      activity: { value: "Drive a sports car", link: "https://www.exoticsracing.com/" },
      game: { value: "Forza Horizon 5", link: "https://store.steampowered.com/app/1551360/Forza_Horizon_5/" },
      quote: { value: "Life is a journey, not a destination.", author: "Ralph Waldo Emerson" },
      moodExplanation: `Feeling ${mood.toLowerCase()} and ready for ${prompt.includes("chicken") ? "a cozy chicken meal" : "a vibrant day"} in ${city || "your city"}.`,
      localEvents: city ? [
        { name: `${city} Car Show`, date: "April 5, 2025", link: `https://example.com/${city.toLowerCase()}-car-show` },
        { name: "Jazz Night", date: "April 6, 2025", link: "https://example.com/jazz-night" },
        { name: "Food Festival", date: "April 7, 2025", link: "https://example.com/food-fest" },
      ] : [
        { name: "Car Show", date: "April 5, 2025", link: "https://example.com/car-show" },
        { name: "Jazz Night", date: "April 6, 2025", link: "https://example.com/jazz-night" },
        { name: "Food Festival", date: "April 7, 2025", link: "https://example.com/food-fest" },
      ],
    };
  }
}

app.post("/generate", async (req, res) => {
  const { prompt, city } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  console.log("Processing prompt:", prompt, "City:", city);
  const moodData = await analyzeMood(prompt);
  const imageUrl = await generateImage(prompt, moodData.mood);
  const recommendations = await generateRecommendations(prompt, moodData.mood, city);

  const response = {
    imageUrl,
    soundtrackUrl: recommendations.music.link, 
    mood: moodData.mood,
    intensity: moodData.intensity,
    moodExplanation: recommendations.moodExplanation,
    recommendations,
  };
  console.log("Sending response:", response);
  res.json(response);
});

const imageDir = path.join(__dirname, "images");
if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});