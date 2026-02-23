const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------- EXPRESS SERVER -------------------
app.get("/", (req, res) => {
  res.send("Kiroflix bot is alive! 🌟");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ------------------- CONFIG -------------------
const TOKEN = "8274005274:AAHxEIeeB8458a5JNxj4SNMMUIhATJnYoGo";
const GEMINI_KEY = "AIzaSyDbxbqyVw4gqu3tJgHsuzuDKTy39imouC0";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

// ------------------- SESSION CACHE -------------------
const SESSION_CACHE_FILE = path.join(__dirname, "userSessions.json");
let sessions = fs.existsSync(SESSION_CACHE_FILE)
  ? JSON.parse(fs.readFileSync(SESSION_CACHE_FILE, "utf-8"))
  : {};

function saveSessionCache() {
  fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify(sessions, null, 2));
}

function initSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = { lastMessageId: null };
  }
}

// ------------------- TELEGRAM BOT -------------------
const bot = new TelegramBot(TOKEN, { polling: true });

// ------------------- HELPERS -------------------
async function updateProgress(chatId, text) {
  initSession(chatId);
  const session = sessions[chatId];

  try {
    if (session.lastMessageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: session.lastMessageId,
        parse_mode: "HTML",
      });
    } else {
      const msg = await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
      });
      session.lastMessageId = msg.message_id;
      saveSessionCache();
    }
  } catch {
    const msg = await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
    });
    session.lastMessageId = msg.message_id;
    saveSessionCache();
  }
}

// ------------------- GEMINI CALL -------------------
async function askAI(userMessage, sessionSummary = "", extraInstruction = "", recentMessages = []) {
  try {
    const historyText = recentMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
      .join("\n");

    const prompt = `
${extraInstruction}

Conversation summary:
${sessionSummary}

Recent conversation:
${historyText}

User message:
${userMessage}

Reply now.
`;

    const res = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_KEY}`,
      {
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }
    );

    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Thinking...";
  } catch (err) {
    console.error("Gemini error:", err.message);
    return null;
  }
}

// ------------------- CLEAN ANIME NAME -------------------
async function extractAnimeName(userMessage) {
  const instruction = `
Extract ONLY the anime title from this message.
Remove words like watch, episode, ep, please, I want, etc.
Reply ONLY with the title.
`;
  const name = await askAI(userMessage, "", instruction);
  return name ? name.replace(/"/g, "").trim() : null;
}

// ------------------- CHOOSE BEST MATCH -------------------
async function chooseBestAnime(userMessage, results) {
  const instruction = `
User request:
${userMessage}

Anime list:
${JSON.stringify(results)}

Choose the BEST matching anime.
Reply ONLY with the anime ID.
`;
  const id = await askAI(userMessage, "", instruction);
  return id ? id.replace(/\D/g, "") : null;
}

// ------------------- EXTRACT EPISODE NUMBER -------------------
function extractEpisodeNumber(text) {
  const match =
    text.match(/episode\s*(\d+)/i) ||
    text.match(/\bep\s*(\d+)/i) ||
    text.match(/\b(\d+)\b/);
  return match ? match[1] : null;
}

// ------------------- SEARCH KIROFLIX ANIME -------------------
async function searchKiroflixAnime(title) {
  try {
    const res = await axios.get(
      "https://creators.kiroflix.site/backend/anime_search.php",
      { params: { q: title } }
    );
    if (!res.data.success || !res.data.results.length) return null;
    return res.data.results;
  } catch {
    return null;
  }
}

// ------------------- FETCH EPISODES -------------------
async function fetchEpisodes(animeId) {
  try {
    const res = await axios.get(
      "https://creators.kiroflix.site/backend/episodes_proxy.php",
      { params: { id: animeId } }
    );
    if (!res.data.success) return null;
    return res.data.episodes;
  } catch {
    return null;
  }
}

// ------------------- GENERATE STREAM LINK -------------------
async function generateStreamLink(episodeId) {
  try {
    const url = `https://kiroflix.cu.ma/generate/generate_episode.php?episode_id=${episodeId}`;
    let attempts = 0;
    while (attempts < 15) {
      const res = await axios.get(url);
      if (res.data.success && res.data.master) {
        return {
          stream: `https://kiroflix.cu.ma/${res.data.master}`,
          subtitle: `https://kiroflix.cu.ma/${res.data.subtitle}`,
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------- BOT LOGIC -------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  await updateProgress(chatId, "🔍 Processing your request...");

  try {
    // 1️⃣ Extract anime name
    const animeTitle = await extractAnimeName(text);
    if (!animeTitle) return updateProgress(chatId, "❌ Anime not detected");

    // 2️⃣ Search anime
    await updateProgress(chatId, "🔎 Searching anime...");
    const results = await searchKiroflixAnime(animeTitle);
    if (!results) return updateProgress(chatId, "❌ Anime not found");

    // 3️⃣ Choose best match
    const animeId = await chooseBestAnime(text, results);
    if (!animeId) return updateProgress(chatId, "❌ Anime match failed");

    // 4️⃣ Extract episode number
    const episodeNumber = extractEpisodeNumber(text);
    if (!episodeNumber) return updateProgress(chatId, "❌ Episode number missing");

    // 5️⃣ Fetch episodes
    await updateProgress(chatId, "📺 Fetching episode...");
    const episodes = await fetchEpisodes(animeId);
    if (!episodes) return updateProgress(chatId, "❌ Episodes not found");

    const episode = episodes.find((e) => e.number == episodeNumber);
    if (!episode) return updateProgress(chatId, "❌ Episode not found");

    // 6️⃣ Generate stream link
    await updateProgress(chatId, "⏳ Generating stream link...");
    const stream = await generateStreamLink(episode.id);
    if (!stream) return updateProgress(chatId, "❌ Stream generation failed");

    // 7️⃣ Send final stream URL
    await bot.sendMessage(chatId, `🎬 Stream ready:\n${stream.stream}`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    console.log(err.message);
    updateProgress(chatId, "❌ Error occurred");
  }
});

// ------------------- START LOG -------------------
console.log("Kiroflix bot is running...");
