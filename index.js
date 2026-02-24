const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// ================= SERVER =================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Kiroflix AI Bot Alive 🌟"));
app.listen(PORT, () => console.log("Server running on port", PORT));

// ================= CONFIG =================
const TOKEN = "8216107970:AAFsGWwTwEJ12iDdyPE4fq_xg1fqlATUKbo";
const GEMINI_KEY = "AIzaSyDbxbqyVw4gqu3tJgHsuzuDKTy39imouC0";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

const bot = new TelegramBot(TOKEN, { polling: true });

// ================= MEMORY =================
const memory = {};

// ================= AI =================
async function askAI(chatId, instruction, userMessage) {

  const context = memory[chatId] || "";

  const prompt = `
${instruction}

Previous context:
${context}

User message:
${userMessage}

Reply in small clear sentence only.
`;

  try {

    const res = await axios.post(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      contents: [{ parts: [{ text: prompt }] }]
    });

    const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    memory[chatId] = reply;

    return reply;

  } catch {
    return null;
  }
}

// ================= EXTRACT =================
async function extractRequest(chatId, text) {

  const prompt = `
Extract:

anime title
episode number
language

Reply JSON only:

{
"title":"",
"episode":"",
"language":""
}
`;

  try {

    const res = await axios.post(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      contents: [{ parts: [{ text: prompt + "\nUser message:\n" + text }] }]
    });

    return JSON.parse(
      res.data.candidates[0].content.parts[0].text
    );

  } catch {
    return null;
  }
}

// ================= API =================
async function searchAnime(title) {

  try {

    const res = await axios.get(
      "https://creators.kiroflix.site/backend/anime_search.php",
      { params: { q: title } }
    );

    return res.data?.results?.[0] || null;

  } catch {
    return null;
  }
}

async function fetchEpisodes(animeId) {

  try {

    const res = await axios.get(
      "https://creators.kiroflix.site/backend/episodes_proxy.php",
      { params: { id: animeId } }
    );

    return res.data?.episodes || [];

  } catch {
    return [];
  }
}

// ================= BOT =================
bot.on("message", async (msg) => {

  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // Extract request
  const req = await extractRequest(chatId, text);

  if (!req || !req.title) {

    const reply = await askAI(
      chatId,
      "Tell user to say anime name.",
      text
    );

    return bot.sendMessage(chatId, reply || "Tell me the anime name.");
  }

  if (!req.episode) {

    const reply = await askAI(
      chatId,
      "Tell user episode number is missing.",
      text
    );

    return bot.sendMessage(chatId, reply || "Tell me the episode number.");
  }

  // Search anime
  const anime = await searchAnime(req.title);

  if (!anime) {

    const reply = await askAI(
      chatId,
      "Tell user anime not found.",
      text
    );

    return bot.sendMessage(chatId, reply || "Anime not found.");
  }

  // Fetch episodes
  const episodes = await fetchEpisodes(anime.id);

  const episode = episodes.find(
    e => String(e.number) === String(req.episode)
  );

  if (!episode) {

    const reply = await askAI(
      chatId,
      "Tell user episode not found.",
      text
    );

    return bot.sendMessage(chatId, reply || "Episode not found.");
  }

  // SUCCESS RESPONSE
  const result = {

    anime_id: anime.id,
    episode_id: episode.id,
    subtitle_language: req.language || "unknown"

  };

  memory[chatId] = JSON.stringify(result);

  bot.sendMessage(chatId, JSON.stringify(result, null, 2));

});

console.log("Kiroflix AI Bot Ready ✅");
