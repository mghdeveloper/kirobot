const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ================= EXPRESS KEEP ALIVE =================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Kiroflix Episode Bot Alive 🌟"));
app.listen(PORT, () => console.log("Server running on port", PORT));

// ================= CONFIG =================
const TOKEN = "8216107970:AAFsGWwTwEJ12iDdyPE4fq_xg1fqlATUKbo";
const GEMINI_KEY = "AIzaSyDbxbqyVw4gqu3tJgHsuzuDKTy39imouC0";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

const bot = new TelegramBot(TOKEN, { polling: true });

// ================= PROGRESS & SESSION =================
const progressCache = {};
const pendingSubs = {};
const subtitleProgress = {};

// ================= HELPER =================
async function updateProgress(chatId, text) {
  try {
    if (progressCache[chatId]) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: progressCache[chatId] });
    } else {
      const msg = await bot.sendMessage(chatId, text);
      progressCache[chatId] = msg.message_id;
    }
  } catch {}
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

async function generateSubtitle(lang, episodeId, chatId) {
  try {
    subtitleProgress[chatId] = { total: 100, done: 0 };
    await updateProgress(chatId, `📝 Generating ${lang} subtitle: 0%`);

    // 1️⃣ Fetch English subtitle
    const vttRes = await axios.get(`https://kiroflix.site/backend/vttreader.php?episode_id=${episodeId}`);
    const lines = vttRes.data.split(/\r?\n/);
    const chunkSize = 100;
    const chunks = [];
    for (let i = 0; i < lines.length; i += chunkSize) chunks.push([i, Math.min(i + chunkSize, lines.length)]);
    const results = [];

    // 2️⃣ Translate each chunk
    for (let i = 0; i < chunks.length; i++) {
      const [start, end] = chunks[i];
      const response = await axios.post(`https://kiroflix.cu.ma/backend/translate_chunk.php`, {
        lang,
        episode_id: episodeId,
        start_line: start,
        end_line: end
      }, { headers: { "Content-Type": "application/json" }, timeout: 30000 });

      results.push(response.data?.translated || lines.slice(start, end).join("\n"));
      subtitleProgress[chatId].done = i + 1;
      await updateProgress(chatId, `📝 Generating ${lang} subtitle: ${Math.floor(((i + 1)/chunks.length)*100)}%`);
    }

    // 3️⃣ Save final VTT file
    const filename = `${episodeId}_${lang.toLowerCase()}.vtt`;
    const filePath = path.join(__dirname, "subtitles");
    if (!fs.existsSync(filePath)) fs.mkdirSync(filePath);
    fs.writeFileSync(path.join(filePath, filename), results.join("\n"));

    await updateProgress(chatId, `✅ ${lang} subtitle generated successfully`);
    return { lang, url: `https://kiroflix.site/backend/vttreader.php?episode_id=${episodeId}&file=${filename}` };

  } catch (err) {
    console.error("Subtitle generation error:", err);
    await updateProgress(chatId, `❌ Failed to generate ${lang} subtitle`);
    return null;
  }
}

// ================= MAIN BOT =================
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  // Check if waiting for subtitle selection
  if (pendingSubs[chatId]) {
    const choice = text.toLowerCase();
    if (["english","arabic","japanese","no subtitle"].includes(choice)) {
      const { episode } = pendingSubs[chatId];
      let subtitleLang = choice === "no subtitle" ? null : choice;
      if (subtitleLang) await generateSubtitle(subtitleLang, episode.id, chatId);

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
    return;
  }

  try {
    await updateProgress(chatId, "🍥 Thinking...");

    // Extract anime & episode
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

    // Check for existing subtitles
    const subs = await checkSubtitles(episode.id);
    let subtitleLang = text.match(/\b(arabic|english|japanese)\b/i)?.[0];
    if (!subtitleLang) {
      pendingSubs[chatId] = { episode, animeId };
      return updateProgress(chatId, "📝 Please specify subtitle language (English, Arabic, Japanese) or reply 'No Subtitle'");
    }

    if (subtitleLang) await generateSubtitle(subtitleLang, episode.id, chatId);

    // Generate stream
    await updateProgress(chatId, "⏳ Generating stream link...");
    const embedLink = `https://kiroflix.cu.ma/generate/player/?episode_id=${episode.id}`;

    const caption = `
🎬 <b>${episode.title}</b>
🖼 <a href="${episode.poster}">Anime Image</a>
🌐 Watch all qualities: ${embedLink}
💬 Subtitle: ${subtitleLang || 'None'}
`;

    await bot.sendMessage(chatId, caption, { parse_mode: "HTML", disable_web_page_preview: false });

  } catch (err) {
    console.log(err);
    updateProgress(chatId, "❌ Error occurred");
  }
});

console.log("Kiroflix Episode Bot Ready ✅");
