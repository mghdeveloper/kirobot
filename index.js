const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// ================= EXPRESS KEEP ALIVE =================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Kiroflix Episode Bot Alive 🌟"));
app.listen(PORT, () => console.log("Server running on port", PORT));

// ================= CONFIG =================
const TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const GEMINI_KEY = "YOUR_GEMINI_KEY";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

const bot = new TelegramBot(TOKEN, { polling: true });

// ================= PROGRESS =================
const progressCache = {};
async function updateProgress(chatId, text) {
  try {
    if (progressCache[chatId]) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: progressCache[chatId] });
    } else {
      const msg = await bot.sendMessage(chatId, text);
      progressCache[chatId] = msg.message_id;
    }
  } catch (err) {}
}

// ================= GEMINI AI =================
async function askAI(message, instruction) {
  try {
    const prompt = `${instruction}\nUser message:\n${message}\nReply ONLY result.`;
    const res = await axios.post(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      contents: [{ parts: [{ text: prompt }] }]
    }, { timeout: 20000 });
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}

// ================= ANIME / EPISODE EXTRACTION =================
async function extractAnimeName(text) {
  return await askAI(text, "Extract ONLY the anime title. Remove words like watch, ep, episode, please.");
}
async function extractEpisodeNumber(text) {
  return (await askAI(text, "Extract ONLY the episode number from this message."))?.match(/\d+/)?.[0];
}
async function chooseAnime(text, results) {
  const id = await askAI(text + JSON.stringify(results), "Choose the BEST matching anime ID. Reply ONLY with the number.");
  return id?.replace(/\D/g, "");
}

// ================= SEARCH & FETCH =================
async function searchAnime(title) {
  try {
    const res = await axios.get("https://creators.kiroflix.site/backend/anime_search.php", { params: { q: title }, timeout: 20000 });
    return res.data.success ? res.data.results : null;
  } catch { return null; }
}
async function fetchEpisodes(animeId) {
  try {
    const res = await axios.get("https://creators.kiroflix.site/backend/episodes_proxy.php", { params: { id: animeId }, timeout: 20000 });
    return res.data.success ? res.data.episodes : null;
  } catch { return null; }
}

// ================= STREAM GENERATION =================
async function generateStream(episodeId) {
  const url = `https://kiroflix.cu.ma/generate/generate_episode.php?episode_id=${episodeId}`;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await axios.get(url, { timeout: 15000 });
      if (res.data.success && res.data.master) return `https://kiroflix.cu.ma/generate/${res.data.master}`;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ================= SUBTITLE HANDLING =================
async function checkSubtitles(episodeId) {
  try {
    const res = await axios.get(`https://kiroflix.cu.ma/generate/getsubs.php?episode_id=${episodeId}`);
    return res.data || [];
  } catch { return []; }
}

// ================= MAIN BOT =================
const pendingSubs = {};

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  try {
    await updateProgress(chatId, "🍥 Thinking...");

    // 1️⃣ Extract anime & episode
    const animeName = await extractAnimeName(text);
    if (!animeName) return updateProgress(chatId, "❌ Anime not detected");

    let epNumber = await extractEpisodeNumber(text);
    await updateProgress(chatId, "🔎 Searching anime...");

    const results = await searchAnime(animeName);
    if (!results) return updateProgress(chatId, "❌ Anime not found");

    const animeId = await chooseAnime(text, results);
    if (!animeId) return updateProgress(chatId, "❌ Match failed");

    await updateProgress(chatId, "📺 Fetching episode...");
    const episodes = await fetchEpisodes(animeId);
    const episode = episodes?.find(e => e.number == epNumber);
    if (!episode) return updateProgress(chatId, "❌ Episode not found");

    // 2️⃣ Subtitle handling
    const subs = await checkSubtitles(episode.id);
    let subtitleLang = text.match(/\b(arabic|english|japanese)\b/i)?.[0];
    if (!subtitleLang) {
      pendingSubs[chatId] = { episode, animeId };
      return updateProgress(chatId, "📝 Please specify subtitle language (English, Arabic, Japanese) or reply 'No Subtitle'");
    }

    // 3️⃣ Generate stream & send embed
    await updateProgress(chatId, "⏳ Generating stream link...");
    const master = await generateStream(episode.id);
    if (!master) return updateProgress(chatId, "❌ Stream generation failed");

    const embedLink = `https://kiroflix.cu.ma/generate/player/?episode_id=${episode.id}`;
    const caption = `
🎬 <b>${episode.title}</b>
🖼 <a href="${episode.poster}">Anime Image</a>
🌐 Watch all qualities: ${embedLink}
💬 Subtitle: ${subtitleLang || 'None'}
`;

    await bot.sendMessage(chatId, caption, { parse_mode: "HTML", disable_web_page_preview: false });
    delete pendingSubs[chatId];

  } catch (err) {
    console.log(err);
    updateProgress(chatId, "❌ Error occurred");
  }
});

// ================= HANDLE SUBTITLE REPLY =================
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const pending = pendingSubs[chatId];
  if (!pending) return;

  const text = msg.text.trim().toLowerCase();
  if (["english","arabic","japanese","no subtitle"].includes(text)) {
    const subtitleLang = text === "no subtitle" ? null : text;

    const { episode } = pending;
    const embedLink = `https://kiroflix.cu.ma/generate/player/?episode_id=${episode.id}`;
    const caption = `
🎬 <b>${episode.title}</b>
🖼 <a href="${episode.poster}">Anime Image</a>
🌐 Watch all qualities: ${embedLink}
💬 Subtitle: ${subtitleLang || 'None'}
`;
    await bot.sendMessage(chatId, caption, { parse_mode: "HTML", disable_web_page_preview: false });
    delete pendingSubs[chatId];
  }
});

console.log("Kiroflix Episode Bot Ready ✅");
