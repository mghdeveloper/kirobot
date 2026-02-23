const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// ------------------- EXPRESS KEEP ALIVE -------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Kiroflix episode bot running 🌟");
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

// ------------------- CONFIG -------------------
const TOKEN = "8274005274:AAHxEIeeB8458a5JNxj4SNMMUIhATJnYoGo";
const GEMINI_KEY = "AIzaSyDbxbqyVw4gqu3tJgHsuzuDKTy39imouC0";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";

const bot = new TelegramBot(TOKEN, {
  polling: true,
  filepath: false
});

// ------------------- VIDEO DIR -------------------
const VIDEO_DIR = path.join(__dirname, "videos");

if (!fs.existsSync(VIDEO_DIR))
  fs.mkdirSync(VIDEO_DIR);

// ------------------- TELEGRAM OPTIMIZED PROGRESS -------------------
async function updateProgress(chatId, text) {
  try {
    await bot.sendMessage(chatId, text);
  } catch {}
}

// ------------------- GEMINI -------------------
async function askAI(message, instruction) {

  try {

    const prompt = `
${instruction}

User message:
${message}

Reply ONLY result.
`;

    const res = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_KEY}`,
      {
        contents: [
          { parts: [{ text: prompt }] }
        ]
      },
      {
        timeout: 20000
      }
    );

    return res.data
      ?.candidates?.[0]
      ?.content?.parts?.[0]
      ?.text
      ?.trim();

  } catch {

    return null;

  }

}

// ------------------- EXTRACT ANIME NAME -------------------
async function extractAnimeName(text) {

  return await askAI(
    text,
    "Extract ONLY anime title."
  );

}

// ------------------- CHOOSE BEST ANIME -------------------
async function chooseAnime(text, results) {

  return (
    await askAI(
      text + JSON.stringify(results),
      "Reply ONLY anime ID."
    )
  )?.replace(/\D/g, "");

}

// ------------------- EXTRACT EPISODE NUMBER -------------------
function extractEpisode(text) {

  return text.match(/\d+/)?.[0];

}

// ------------------- SEARCH ANIME -------------------
async function searchAnime(title) {

  try {

    const res = await axios.get(
      "https://creators.kiroflix.site/backend/anime_search.php",
      {
        params: { q: title },
        timeout: 20000
      }
    );

    return res.data.success
      ? res.data.results
      : null;

  } catch {

    return null;

  }

}

// ------------------- FETCH EPISODES -------------------
async function fetchEpisodes(id) {

  try {

    const res = await axios.get(
      "https://creators.kiroflix.site/backend/episodes_proxy.php",
      {
        params: { id },
        timeout: 20000
      }
    );

    return res.data.success
      ? res.data.episodes
      : null;

  } catch {

    return null;

  }

}

// ------------------- GENERATE STREAM -------------------
async function generateStream(episodeId) {

  const url =
    `https://kiroflix.cu.ma/generate/generate_episode.php?episode_id=${episodeId}`;

  for (let i = 0; i < 15; i++) {

    try {

      const res = await axios.get(url);

      if (res.data.success)
        return `https://kiroflix.cu.ma/generate/${res.data.master}`;

    } catch {}

    await new Promise(r => setTimeout(r, 2000));

  }

  return null;

}

// ------------------- GET 360p -------------------
async function get360p(masterUrl) {

  const res = await axios.get(masterUrl);

  const lines = res.data.split("\n");

  for (let i = 0; i < lines.length; i++) {

    if (lines[i].includes("RESOLUTION=640x360")) {

      return new URL(
        lines[i + 1],
        masterUrl
      ).href;

    }

  }

  return null;

}

// ------------------- CONVERT TO MP4 -------------------
function convertToMP4(input, output) {

  return new Promise((resolve, reject) => {

    const cmd =
      `ffmpeg -y -loglevel error -i "${input}" -c copy -bsf:a aac_adtstoasc "${output}"`;

    exec(cmd, err =>
      err ? reject(err) : resolve()
    );

  });

}

// ------------------- SEND VIDEO -------------------
async function sendVideo(chatId, file, episodeId) {

  await bot.sendVideo(chatId, file, {
    caption:
`✅ 360p ready

🌐 Watch other qualities:
https://kiroflix.cu.ma/generate/player/?episode_id=${episodeId}`,
    supports_streaming: true
  });

}

// ------------------- BOT MAIN -------------------
bot.on("message", async msg => {

  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  try {

    await updateProgress(chatId, "🍥 Thinking...");

    const animeName =
      await extractAnimeName(text);

    if (!animeName)
      return updateProgress(chatId, "❌ Anime not found");

    await updateProgress(chatId, "🔎 Searching anime...");

    const results =
      await searchAnime(animeName);

    if (!results)
      return updateProgress(chatId, "❌ No results");

    const animeId =
      await chooseAnime(text, results);

    if (!animeId)
      return updateProgress(chatId, "❌ Match failed");

    const epNumber =
      extractEpisode(text);

    if (!epNumber)
      return updateProgress(chatId, "❌ Episode missing");

    await updateProgress(chatId, "📺 Fetching episode...");

    const episodes =
      await fetchEpisodes(animeId);

    const episode =
      episodes.find(
        e => e.number == epNumber
      );

    if (!episode)
      return updateProgress(chatId, "❌ Episode not found");

    await updateProgress(chatId, "⏳ Generating stream...");

    const master =
      await generateStream(episode.id);

    if (!master)
      return updateProgress(chatId, "❌ Stream failed");

    await updateProgress(chatId, "⚙️ Preparing 360p...");

    const m3u8 =
      await get360p(master);

    if (!m3u8)
      return updateProgress(chatId, "❌ 360p not found");

    const file =
      `${VIDEO_DIR}/${episode.id}_360.mp4`;

    await updateProgress(chatId, "📦 Converting...");

    await convertToMP4(m3u8, file);

    await updateProgress(chatId, "📤 Uploading...");

    await sendVideo(chatId, file, episode.id);

    fs.unlinkSync(file);

  } catch {

    updateProgress(chatId, "❌ Error");

  }

});

console.log("Kiroflix bot ready ✅");
