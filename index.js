const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// -------------------- SERVER --------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => res.send("Kiroflix bot alive 🌟"));
app.listen(PORT, () => console.log("[SERVER] Running on", PORT));

// -------------------- CONFIG --------------------
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

const bot = new TelegramBot(TOKEN, { polling: true });

// -------------------- LOGGER --------------------
function logStep(step, data = "") {
  console.log(`\n===== ${step} =====`);
  if (data) console.log(data);
}

function logError(context, err) {
  console.error(`\n❌ ERROR in ${context}`);
  console.error("Message:", err.message);
  console.error("Stack:", err.stack);
  if (err.response?.data)
    console.error("API Response:", err.response.data);
}

// -------------------- AI CORE --------------------
async function askAI(prompt) {
  try {
    logStep("AI REQUEST PROMPT", prompt);

    const { data } = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    logStep("AI RESPONSE", text);
    return text;

  } catch (err) {
    logError("AI CALL", err);
    return "";
  }
}

// -------------------- INTENT --------------------
async function parseIntent(text) {
  try {
    logStep("USER MESSAGE", text);

    const prompt = `
Extract anime title, season/part (if any), and episode.
Return ONLY JSON:
{"title":"anime title","season":"season info or null","episode":number}
User: ${text}
`;

    let res = await askAI(prompt);
    res = res.replace(/```json|```/gi, "").trim();
    const json = res.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("No JSON from AI");

    const parsed = JSON.parse(json);
    logStep("PARSED INTENT", parsed);

    return parsed;
  } catch (err) {
    logError("INTENT PARSE", err);

    // fallback regex
    const ep = text.match(/ep(?:isode)?\s*(\d+)/i)?.[1];
    const season = text.match(/season\s*(\d+)/i)?.[1] || null;
    const title = text
      .replace(/ep(?:isode)?\s*\d+/i, "")
      .replace(/season\s*\d+/i, "")
      .trim();

    if (title && ep) {
      const fallback = { title, season, episode: Number(ep) };
      logStep("FALLBACK INTENT", fallback);
      return fallback;
    }

    return null;
  }
}

// -------------------- SEARCH --------------------
async function searchAnime(title) {
  try {
    logStep("SEARCH TITLE", title);

    const { data } = await axios.get(
      "https://creators.kiroflix.site/backend/anime_search.php",
      { params: { q: title } }
    );

    logStep("SEARCH RESULT COUNT", data.results?.length);
    return data.results || [];

  } catch (err) {
    logError("ANIME SEARCH", err);
    return [];
  }
}

// -------------------- AI MATCH --------------------
async function chooseBestAnime(intent, results) {
  try {
    const minimal = results.map(a => ({
      id: a.id,
      title: a.title
    }));

    logStep("AI MATCH INPUT", minimal);

    const prompt = `
User searching: "${intent.title}"${intent.season ? " season " + intent.season : ""}
Return ONLY the id of the best match from this list:
${JSON.stringify(minimal)}
`;

    const res = await askAI(prompt);
    const id = res.match(/\d+/)?.[0];

    if (!id) {
      logStep("AI MATCH FALLBACK", "Using first result");
      return results[0];
    }

    const anime = results.find(a => a.id === id);
    logStep("AI MATCH RESULT", anime);

    return anime || results[0];

  } catch (err) {
    logError("AI MATCH", err);
    return results[0];
  }
}
// -------------------- EPISODES --------------------
async function getEpisodes(id) {
  try {
    logStep("FETCH EPISODES FOR", id);

    const { data } = await axios.get(
      "https://creators.kiroflix.site/backend/episodes_proxy.php",
      { params: { id } }
    );

    logStep("EPISODES COUNT", data.episodes?.length);
    return data.episodes || [];

  } catch (err) {
    logError("EPISODES FETCH", err);
    return [];
  }
}

// -------------------- STREAM GENERATOR --------------------
async function generateStream(episodeId) {
  try {
    const { data } = await axios.get(
      "https://kiroflix.cu.ma/generate/generate_episode.php",
      {
        params: { episode_id: episodeId },
        timeout: 40000 // 40 seconds
      }
    );

    if (!data?.success) return null;

    return {
      player: `https://kiroflix.cu.ma/generate/player/?episode_id=${episodeId}`,
      master: data.master,
      subtitle: data.subtitle
    };

  } catch (err) {
    console.error("❌ Stream generation error:", err.message);
    return null;
  }
}

// -------------------- BOT --------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  try {
    logStep("NEW REQUEST", text);
    await bot.sendMessage(chatId, "🍿 Finding your episode...");

    // 1️⃣ intent
    const intent = await parseIntent(text);
    if (!intent) {
      await bot.sendMessage(chatId, "❌ Could not understand request");
      return;
    }

    // 2️⃣ search
    const results = await searchAnime(intent.title);
    if (!results.length) {
      await bot.sendMessage(chatId, "❌ Anime not found");
      return;
    }

    // 3️⃣ match
    const anime = await chooseBestAnime(intent.title, results);

    // 4️⃣ episodes
    const episodes = await getEpisodes(anime.id);
    if (!episodes.length) {
      await bot.sendMessage(chatId, "❌ Episodes unavailable");
      return;
    }

    const episode =
      episodes.find(e => Number(e.number) === Number(intent.episode)) ||
      episodes[0];

    if (!episode) {
      await bot.sendMessage(chatId, "❌ Episode not found");
      return;
    }

    // 5️⃣ generate stream
    const stream = await generateStream(episode.id);
    if (!stream) {
      await bot.sendMessage(chatId, "❌ Could not generate stream");
      return;
    }

    // 6️⃣ stylish reply
    const caption = `
🎬 <b>${anime.title}</b>
📺 Episode ${episode.number}: ${episode.title}
🆔 <code>${episode.id}</code>
▶️ <a href="${stream.player}">Watch Now</a>
`;

    if (anime.poster) {
      await bot.sendPhoto(chatId, anime.poster, {
        caption,
        parse_mode: "HTML",
        disable_notification: false,
      });
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: "HTML" });
    }

    logStep("REPLY SENT", {
      anime: anime.title,
      episode: episode.number,
      player: stream.player
    });

  } catch (err) {
    logError("MAIN BOT HANDLER", err);
    await bot.sendMessage(chatId, "⚠️ Something went wrong");
  }
});

console.log("🎬 Kiroflix Debug Bot Running");
