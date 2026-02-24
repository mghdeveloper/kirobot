const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// -------------------- SERVER --------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => res.send("Kiroflix bot is alive 🌟"));
app.listen(PORT, () => console.log("Server running on " + PORT));

// -------------------- CONFIG --------------------
const TOKEN = "8216107970:AAFsGWwTwEJ12iDdyPE4fq_xg1fqlATUKbo";
const GEMINI_KEY = "AIzaSyDbxbqyVw4gqu3tJgHsuzuDKTy39imouC0";


const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

const bot = new TelegramBot(TOKEN, { polling: true });

// -------------------- AI CORE --------------------
async function askAI(prompt) {
  try {
    const { data } = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );

    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (err) {
    console.error("AI error:", err.message);
    return "";
  }
}

// -------------------- PARSE INTENT --------------------
async function parseIntent(text) {
  const prompt = `
Extract anime title and episode.

Return ONLY JSON:
{"title":"anime title","episode":number}

User: ${text}
`;

  try {
    let res = await askAI(prompt);
    res = res.replace(/```json|```/gi, "").trim();

    const json = res.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch {
    const ep = text.match(/ep(?:isode)?\s*(\d+)/i)?.[1];
    const title = text.replace(/ep(?:isode)?\s*\d+/i, "").trim();
    return title && ep ? { title, episode: Number(ep) } : null;
  }
}

// -------------------- SEARCH --------------------
async function searchAnime(title) {
  try {
    const { data } = await axios.get(
      "https://creators.kiroflix.site/backend/anime_search.php",
      { params: { q: title } }
    );
    return data.results || [];
  } catch {
    return [];
  }
}

// -------------------- AI BEST MATCH --------------------
async function chooseBestAnime(userTitle, results) {
  // 🔥 ONLY send minimal data to AI
  const minimal = results.map(a => ({
    id: a.id,
    title: a.title
  }));

  const prompt = `
User is searching for "${userTitle}"

Choose the BEST matching anime.

Rules:
- Prefer exact title
- Prefer main series over movies
- Return ONLY the id

List:
${JSON.stringify(minimal)}
`;

  const res = await askAI(prompt);
  const id = res.match(/\d+/)?.[0];

  return results.find(a => a.id === id) || results[0];
}

// -------------------- EPISODES --------------------
async function getEpisodes(id) {
  try {
    const { data } = await axios.get(
      "https://creators.kiroflix.site/backend/episodes_proxy.php",
      { params: { id } }
    );
    return data.episodes || [];
  } catch {
    return [];
  }
}

// -------------------- BOT --------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  try {
    await bot.sendMessage(chatId, "🍿 Finding your episode...");

    // 1️⃣ intent
    const intent = await parseIntent(text);
    if (!intent)
      return bot.sendMessage(chatId, "❌ Could not understand request");

    // 2️⃣ search
    const results = await searchAnime(intent.title);
    if (!results.length)
      return bot.sendMessage(chatId, "❌ Anime not found");

    // 3️⃣ best anime
    const anime = await chooseBestAnime(intent.title, results);

    // 4️⃣ episodes
    const episodes = await getEpisodes(anime.id);
    const episode = episodes.find(
      e => Number(e.number) === Number(intent.episode)
    );

    if (!episode)
      return bot.sendMessage(chatId, "❌ Episode not found");

    // 5️⃣ reply
    const caption = `
🎬 <b>${anime.title}</b>
📺 Episode ${episode.number}: ${episode.title}
🆔 <code>${episode.id}</code>
`;

    await bot.sendPhoto(chatId, anime.poster, {
      caption,
      parse_mode: "HTML"
    });

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "⚠️ Error occurred");
  }
});

console.log("🎬 Kiroflix bot running");
