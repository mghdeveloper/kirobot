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
Extract anime title, season/part (if any), episode, 
and if the user is requesting a subtitle (optional language).
Return ONLY JSON:
{"title":"anime title","season":"season info or null","episode":number,"subtitle":null,"subtitleLang":null}
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

    // fallback regex for episode & subtitle
    const ep = text.match(/ep(?:isode)?\s*(\d+)/i)?.[1];
    const season = text.match(/season\s*(\d+)/i)?.[1] || null;
    const title = text
      .replace(/ep(?:isode)?\s*\d+/i, "")
      .replace(/season\s*\d+/i, "")
      .replace(/subtitle/i, "")
      .trim();

    const subtitleMatch = text.match(/subtitle(?: in)?\s*([a-zA-Z]+)/i);
    const subtitleLang = subtitleMatch ? subtitleMatch[1] : null;

    if (title && ep) {
      const fallback = { title, season, episode: Number(ep), subtitle: !!subtitleLang, subtitleLang };
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
async function fetchAvailableSubtitles(episodeId) {
  try {
    const { data } = await axios.get(`https://kiroflix.cu.ma/generate/getsubs.php`, {
      params: { episode_id: episodeId }
    });
    return data || [];
  } catch (err) {
    console.error("❌ Failed to fetch subtitles:", err.message);
    return [];
  }
}

async function generateSubtitle(chatId, episodeId, lang = "English") {
  const progressMsg = await bot.sendMessage(chatId, `🎯 Generating ${lang} subtitle... 0%`);

  try {
    // 1️⃣ Fetch the base English VTT
    const { data: vttText } = await axios.get(`https://creators.kiroflix.site/backend/vttreader.php`, {
      params: { episode_id: episodeId }
    });
    const lines = vttText.split(/\r?\n/);

    // 2️⃣ Split into chunks
    const chunkSize = 100;
    const chunks = [];
    for (let i = 0; i < lines.length; i += chunkSize) {
      chunks.push([i, Math.min(i + chunkSize - 1, lines.length - 1)]);
    }

    const results = new Array(chunks.length);
    let completedChunks = 0;

    // 3️⃣ Generate subtitle chunks in parallel
    await Promise.all(chunks.map(async ([start, end], index) => {
      try {
        const { data: translated } = await axios.post(`https://kiroflix.cu.ma/generate/translate_chunk.php`, {
          lang,
          episode_id: episodeId,
          start_line: start,
          end_line: end
        });
        results[index] = translated.trim();
      } catch (err) {
        console.error(`❌ Chunk ${index} failed:`, err.message);
        results[index] = ""; // leave empty if failed
      }

      // Update progress for each completed chunk
      completedChunks++;
      const percent = Math.floor((completedChunks / chunks.length) * 100);
      await bot.editMessageText(`🎯 Generating ${lang} subtitle... ${percent}%`, {
        chat_id: chatId,
        message_id: progressMsg.message_id
      });
    }));

    // 4️⃣ Combine results and save
    const finalSubtitle = results.join("\n");
    const filename = `${lang.toLowerCase()}.vtt`;

    await axios.post(`https://kiroflix.cu.ma/generate/save_subtitle.php`, {
      episode_id: episodeId,
      filename,
      content: finalSubtitle
    });

    await axios.post(`https://creators.kiroflix.site/backend/store_subtitle.php`, {
      episode_id: episodeId,
      language: lang,
      subtitle_url: `https://kiroflix.cu.ma/generate/episodes/${episodeId}/${filename}`
    });

    await bot.editMessageText(`✅ ${lang} subtitle ready!`, {
      chat_id: chatId,
      message_id: progressMsg.message_id
    });

    return `https://kiroflix.cu.ma/generate/episodes/${episodeId}/${filename}`;

  } catch (err) {
    console.error("❌ Subtitle generation failed:", err.message);
    await bot.editMessageText(`❌ Failed to generate ${lang} subtitle`, {
      chat_id: chatId,
      message_id: progressMsg.message_id
    });
    return null;
  }
}
// -------------------- BOT COMMANDS --------------------

// /start - show tutorial
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const tutorial = `
🎬 Welcome to Kiroflix Bot!

To get a stream link for any anime:
1️⃣ Send the anime title
2️⃣ Include the episode number (e.g., "Episode 1")
3️⃣ Optionally, include the subtitle language (e.g., "subtitle in French")

The bot will reply with the <b>Watch Now</b> link to the embedded player.
Enjoy! 🍿
`;
  await bot.sendMessage(chatId, tutorial, { parse_mode: "HTML" });
});

// /help - show instructions
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
💡 Kiroflix Bot Commands:

/start - Show this tutorial
/help - Show instructions
/latest - Show latest episodes with Watch Now links

Send anime title and episode number to get the stream.
Optionally include a subtitle language if needed.
`;
  await bot.sendMessage(chatId, helpMessage, { parse_mode: "HTML" });
});

const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "latest.json");
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

bot.onText(/\/latest/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // ---------- 1️⃣ Check cache ----------
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));

      const isValid = Date.now() - cache.timestamp < CACHE_TTL;

      if (isValid) {
        // ✅ Send cached file directly
        await bot.sendDocument(chatId, CACHE_FILE, {
          caption: "📦 Latest episodes (cached)"
        });
        return;
      }
    }

    // ---------- 2️⃣ Fetch fresh data ----------
    await bot.sendMessage(chatId, "⏳ Updating latest episodes...");

    const { data } = await axios.get(
      "https://creators.kiroflix.site/backend/lastep.php"
    );

    const latestEpisodes = data?.results || [];
    if (!latestEpisodes.length) {
      await bot.sendMessage(chatId, "⚠️ No latest episodes found.");
      return;
    }

    // ---------- 3️⃣ Generate streams in parallel ----------
    const streams = await Promise.all(
      latestEpisodes.map(ep => generateStream(ep.episode_id))
    );

    const payload = latestEpisodes.map((ep, i) => ({
      anime_title: ep.anime_title,
      episode_number: ep.latest_episode_number,
      episode_title: ep.episode_title,
      episode_id: ep.episode_id,
      player: streams[i]?.player || null
    }));

    const cacheData = {
      timestamp: Date.now(),
      count: payload.length,
      results: payload
    };

    // ---------- 4️⃣ Save cache ----------
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));

    // ---------- 5️⃣ Send file ----------
    await bot.sendDocument(chatId, CACHE_FILE, {
      caption: "📦 Latest episodes (fresh)"
    });

  } catch (err) {
    logError("LATEST COMMAND", err);
    await bot.sendMessage(chatId, "❌ Failed to fetch latest episodes.");
  }
});
// -------------------- BOT --------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  // ✅ Skip commands
  if (text.startsWith("/")) return;

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
    const anime = await chooseBestAnime(intent, results);

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

    // Check if the user requested a subtitle
    if (intent.subtitle) {
      const lang = intent.subtitleLang || "English";

      // Check if subtitle already exists
      const subs = await fetchAvailableSubtitles(episode.id);
      const existing = subs.find(s => s.lang.toLowerCase() === lang.toLowerCase());

      if (existing) {
        await bot.sendMessage(chatId, `🎯 Subtitle already available: ${existing.lang} - ${existing.file}`);
      } else {
        // Generate subtitle if not found
        await generateSubtitle(chatId, episode.id, lang);
      }
    }

  } catch (err) {
    logError("MAIN BOT HANDLER", err);
    await bot.sendMessage(chatId, "⚠️ Something went wrong");
  }
});

console.log("🎬 Kiroflix Debug Bot Running");
