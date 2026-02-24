const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// -------------------- SERVER --------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Kiroflix bot is alive! 🌟");
});

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
    const res = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );

    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (err) {
    console.error("AI error:", err.message);
    return null;
  }
}

// -------------------- INTENT PARSER --------------------
async function parseIntent(userText) {
  const prompt = `
Extract the anime request.

Return ONLY valid JSON.
No markdown.
No explanation.

Format:
{"title":"english anime title","episode":number}

User: ${userText}
`;

  try {
    let res = await askAI(prompt);

    if (!res) throw new Error("Empty AI response");

    console.log("AI RAW:", res);

    // 🧹 remove markdown code blocks ```json ```
    res = res.replace(/```json|```/gi, "").trim();

    // 🧹 remove triple quotes """
    res = res.replace(/"""/g, "").trim();

    // 🧠 extract JSON object
    const match = res.match(/\{[\s\S]*\}/);

    if (match) {
      return JSON.parse(match[0]);
    }

    throw new Error("No JSON found");

  } catch (err) {
    console.log("AI parse failed, using fallback…");

    // 🔁 fallback regex
    const epMatch = userText.match(/ep(?:isode)?\s*(\d+)/i);
    const episode = epMatch ? Number(epMatch[1]) : null;

    const title = userText
      .replace(/ep(?:isode)?\s*\d+/i, "")
      .replace(/season\s*\d+/i, "")
      .trim();

    if (!title || !episode) return null;

    return { title, episode };
  }
}
// -------------------- SEARCH ANIME --------------------
async function searchAnime(title) {
  try {
    const res = await axios.get(
      "https://creators.kiroflix.site/backend/anime_search.php",
      { params: { q: title } }
    );

    return res.data.results || [];
  } catch (err) {
    console.error("Search error:", err.message);
    return [];
  }
}
async function chooseBestAnime(userQuery, results) {

  const simplified = results.map(r => ({
    id: r.id,
    title: r.title,
    info: r.info
  }));

  const prompt = `
User is searching for: "${userQuery}"

Choose the BEST matching anime from this list.

Priorities:
1️⃣ Main TV series over movies/ONA/specials
2️⃣ Exact title match
3️⃣ Highest episode count if multiple

Return ONLY the id.

List:
${JSON.stringify(simplified, null, 2)}
`;

  const res = await askAI(prompt);

  const idMatch = res.match(/\d+/);

  return idMatch ? idMatch[0] : results[0].id;
}
// -------------------- AI PICK BEST ANIME --------------------
async function chooseBestAnime(userText, results) {
  const list = results
    .map((a, i) => `${i + 1}. ${a.title} (${a.info})`)
    .join("\n");

  const prompt = `
User request: "${userText}"

Which anime matches best?

${list}

Reply ONLY the number.
`;

  const res = await askAI(prompt);
  const index = Number(res?.match(/\d+/)?.[0]) - 1;

  return results[index] || results[0];
}

// -------------------- GET EPISODES --------------------
async function getEpisodes(animeId) {
  try {
    const res = await axios.get(
      "https://creators.kiroflix.site/backend/episodes_proxy.php",
      { params: { id: animeId } }
    );

    return res.data.episodes || [];
  } catch (err) {
    console.error("Episodes error:", err.message);
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

    // 1️⃣ parse user intent
    const intent = await parseIntent(text);

    if (!intent) {
      await bot.sendMessage(chatId, "❌ I couldn’t understand the request");
      return;
    }

    // 2️⃣ search anime
    const results = await searchAnime(intent.title);

    if (results.length === 0) {
      await bot.sendMessage(chatId, "❌ Anime not found");
      return;
    }

    // 3️⃣ AI decides best match
    const bestId = await chooseBestAnime(userText, results);
const anime = results.find(a => a.id === bestId) || results[0];

    // 4️⃣ get episodes
    const episodes = await getEpisodes(anime.id);

    const ep = episodes.find(
      (e) => Number(e.number) === Number(intent.episode)
    );

    if (!ep) {
      await bot.sendMessage(chatId, "❌ Episode not found");
      return;
    }

    // 5️⃣ reply
    const caption = `
🎬 <b>${anime.title}</b>

📺 Episode ${ep.number}: ${ep.title}

🆔 Episode ID: <code>${ep.id}</code>

ℹ️ ${anime.info}

Enjoy 🍿
`;

    await bot.sendPhoto(chatId, anime.poster, {
      caption,
      parse_mode: "HTML"
    });

  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "⚠️ Something went wrong");
  }
});

// -------------------- START LOG --------------------
console.log("Kiroflix streaming bot running 🎬");
