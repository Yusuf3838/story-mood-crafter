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

async function generateRecommendations(prompt, mood) {
  try {
    const recPrompt = `[INST] Return only a valid JSON object for "${prompt}" with a ${mood} mood: a soothing soundtrack (YouTube URL like https://www.youtube.com/watch?v=...), a book, a TV show, a podcast, a food item, and a short mood explanation (20-30 words). Format: {"music": "", "book": "", "tv": "", "podcast": "", "food": "", "moodExplanation": ""} [/INST]`;
    console.log("Starting text generation for:", recPrompt);

    const response = await axios.post(TEXT_GEN_URL, {
      inputs: recPrompt,
      parameters: { max_length: 250, temperature: 0.7, return_full_text: false },
    }, {
      headers: { Authorization: `Bearer ${HF_API_TOKEN}`, "Content-Type": "application/json" },
    });

    console.log("Raw HF Text Response:", response.data);
    const output = response.data[0].generated_text.trim();
    console.log("Generated Text:", output);

    try {
      const textResult = JSON.parse(output);
      return textResult;
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError.message);
      throw new Error("Failed to parse JSON from Mixtral response");
    }
  } catch (error) {
    console.error("HF Text Generation Error:", error.message, error.response?.data);
    return {
      music: "https://www.youtube.com/watch?v=CvFH_6DNRCY",
      book: "The Great Gatsby by F. Scott Fitzgerald",
      tv: "Top Gear",
      podcast: "The Car Show",
      food: "Caviar",
      moodExplanation: "Spotting Lambos sparks a chill thrill—luxury vibes and smooth tunes.",
    };
  }
}

app.post("/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  console.log("Processing prompt:", prompt);
  const moodData = await analyzeMood(prompt);
  const imageUrl = await generateImage(prompt, moodData.mood);
  const recommendations = await generateRecommendations(prompt, moodData.mood);

  const response = {
    imageUrl,
    soundtrackUrl: recommendations.music,
    mood: moodData.mood,
    intensity: moodData.intensity,
    moodExplanation: recommendations.moodExplanation,
    recommendations: {
      book: recommendations.book,
      tv: recommendations.tv,
      podcast: recommendations.podcast,
      food: recommendations.food,
    },
  };
  console.log("Sending response:", response);
  res.json(response);
});

const imageDir = path.join(__dirname, "images");
if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});