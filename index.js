const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Simple endpoint to respond to pings
app.get("/", (req, res) => {
  res.send("Kiroflix bot is alive! 🌟");
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// -------------------- CONFIG --------------------
const TOKEN = "8216107970:AAFsGWwTwEJ12iDdyPE4fq_xg1fqlATUKbo";
const GEMINI_KEY = "AIzaSyDbxbqyVw4gqu3tJgHsuzuDKTy39imouC0";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent";
const SERPAPI_KEY = "80ac13f5265d00b05317a58cdde9223caa2c64a45e60e460c1c435a2a9b7aa96";

// -------------------- CACHE FILES --------------------
const SEARCH_CACHE_FILE = path.join(__dirname, "searchCache.json");
const SESSION_CACHE_FILE = path.join(__dirname, "userSessions.json");

let searchCache = fs.existsSync(SEARCH_CACHE_FILE)
  ? JSON.parse(fs.readFileSync(SEARCH_CACHE_FILE, "utf-8"))
  : {};

let sessions = fs.existsSync(SESSION_CACHE_FILE)
  ? JSON.parse(fs.readFileSync(SESSION_CACHE_FILE, "utf-8"))
  : {};

// -------------------- TELEGRAM BOT --------------------
const bot = new TelegramBot(TOKEN, { polling: true });

// -------------------- MASTER SYSTEM PROMPT --------------------
const MASTER_PROMPT = `
You are Kiroflix, a friendly, human-like multilingual anime assistant.

LANGUAGE RULES:
- Detect the user's language automatically.
- ALWAYS reply ONLY in the user's language.
- NEVER mix languages.
- Match the user's tone naturally.

HUMAN STYLE RULES:
- Sound natural, friendly, and conversational.
- Use emojis appropriately (not too many, but enough to feel human).
- Show enthusiasm about anime.
- Avoid robotic or overly formal tone.
- Feel like chatting with a real anime fan.

SUGGESTION RULE (VERY IMPORTANT):
- ALWAYS finish your reply with a suggestion for a next topic.
- Suggest based on the current context.
- Examples:
  - Ask what genre they like
  - Suggest similar anime
  - Offer character info
  - Offer latest releases
  - Offer hidden gems

FORMATTING RULES:
- Use HTML formatting for Telegram.
- Use bullet points with: •
- Use <b>Bold</b> for anime titles
- Add clean spacing between items
- Use emojis to improve readability
Example format (FORMAT ONLY):

✨ Here are some great anime:

• <b>Attack on Titan</b>: A dark and intense story about humanity's survival 🛡️

• <b>Death Note</b>: A smart psychological thriller full of mind games 🧠


IMAGE RULE:
- If image URLs are provided, mention them naturally in your response.
- Prefer showing main anime cover images.

IDENTITY:
- You are passionate about anime.
- You love helping users discover anime.
- Be helpful, modern, and engaging.

Always follow these rules strictly.
`;


// -------------------- HELPERS --------------------
function saveSearchCache() {
  fs.writeFileSync(SEARCH_CACHE_FILE, JSON.stringify(searchCache, null, 2));
}

function saveSessionCache() {
  fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify(sessions, null, 2));
}

function initSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      messages: [],
      lastMessageId: null,
      summary: "",
    };
  }
}

// -------------------- PROGRESS MESSAGE --------------------
async function updateProgress(chatId, text) {

  initSession(chatId);

  const session = sessions[chatId];

  try {

    if (session.lastMessageId) {

      await bot.editMessageText(text, {

        chat_id: chatId,
        message_id: session.lastMessageId,
        parse_mode: "HTML"

      });

    } else {

      const msg = await bot.sendMessage(chatId, text, {
        parse_mode: "HTML"
      });

      session.lastMessageId = msg.message_id;

      saveSessionCache();

    }

  } catch {

    const msg = await bot.sendMessage(chatId, text, {
      parse_mode: "HTML"
    });

    session.lastMessageId = msg.message_id;

    saveSessionCache();

  }
}

async function sendModernReply(chatId, text, images = []) {

  if (images.length > 0) {

    await bot.sendPhoto(chatId, images[0], {
      caption: text,
      parse_mode: "HTML"
    });

  } else {

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML"
    });

  }

}

// -------------------- GEMINI CALL --------------------
async function askAI(userMessage, sessionSummary = "", extraInstruction = "") {
  try {

    const prompt = `
${MASTER_PROMPT}

${extraInstruction}

Conversation summary:
${sessionSummary}

User message:
${userMessage}

Reply now.
`;

    const res = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_KEY}`,
      {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      }
    );

    return (
      res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      "Kiroflix is thinking..."
    );

  } catch (err) {
    console.error("Gemini error:", err.message);
    return "Kiroflix AI is busy 🍿";
  }
}

// -------------------- SESSION SUMMARY --------------------
async function summarizeSession(session) {

  if (session.messages.length < 4) return session.summary;

  const lastMessages = session.messages.slice(-10);

  const summaryInstruction = `
Summarize this conversation in 2 short sentences.
Keep key anime topics, titles, and user preferences.
Reply in the user's language.
`;

  const summary = await askAI(
    JSON.stringify(lastMessages),
    "",
    summaryInstruction
  );

  session.summary = summary;
  saveSessionCache();

  return summary;
}

// -------------------- SEARCH --------------------
async function searchAnime(query) {

  const now = Date.now();

  if (
    searchCache[query] &&
    now - searchCache[query].timestamp < 86400000
  ) {
    return searchCache[query].results;
  }

  try {

    const res = await axios.get(
      "https://serpapi.com/search.json",
      {
        params: {
          engine: "google",
          q: query,
          api_key: SERPAPI_KEY,
          num: 5,
        },
      }
    );

    const results = (res.data.organic_results || [])
      .slice(0, 5)
      .map(r => ({
        title: r.title,
        snippet: r.snippet,
        link: r.link,
        image: r.thumbnail || null
      }));

    searchCache[query] = {
      timestamp: now,
      results
    };

    saveSearchCache();

    return results;

  } catch (err) {
    console.error(err.message);
    return [];
  }
}

// -------------------- DECIDE SEARCH --------------------
async function shouldSearch(text, summary) {

  const instruction = `
Decide if this needs real-time info like release dates, news, schedules.

Reply ONLY:
SEARCH
or
DIRECT
`;

  const decision = await askAI(text, summary, instruction);

  return decision.includes("SEARCH");
}

// -------------------- BOT LOGIC --------------------
bot.on("message", async (msg) => {

  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  initSession(chatId);

  const session = sessions[chatId];

  if (text === "/start") {

    const welcome = await askAI(
      "Welcome the user briefly.",
      "",
      "Welcome the user to Kiroflix anime assistant."
    );

    const m = await bot.sendMessage(chatId, welcome, {
  parse_mode: "HTML"
});


    session.lastMessageId = m.message_id;

    saveSessionCache();

    return;
  }

  await updateProgress(chatId, "🍥 Thinking...");

  const summary = session.summary || "";

  const needSearch = await shouldSearch(text, summary);

  let reply = "";

  if (needSearch) {

  await updateProgress(chatId, "🔍 Searching...");

  const results = await searchAnime(text);

  const formatted = results.map(r =>
    `${r.title}\n${r.snippet}`
  ).join("\n\n");

  const instruction = `
Use these search results to answer accurately.
Do not invent facts.
`;

  reply = await askAI(
    text + "\n\nSearch results:\n" + formatted,
    summary,
    instruction
  );

  // ✅ extract images
  const imageUrls = results
    .filter(r => r.image)
    .map(r => r.image);

  // ✅ send modern reply with image
  await sendModernReply(chatId, reply, imageUrls);

} else {

    const instruction = `
Answer clearly and helpfully.
Recommend anime if relevant.
`;

    reply = await askAI(text, summary, instruction);

  }

  session.messages.push({ role: "user", text });
  session.messages.push({ role: "bot", text: reply });

  saveSessionCache();

  await updateProgress(chatId, reply);

  await summarizeSession(session);

  session.lastMessageId = null;

});

// -------------------- START LOG --------------------
console.log("Kiroflix bot is running...");
const SELF_URL = "https://libby.onrender.com/";

async function selfPing() {
  try {
    const res = await fetch(SELF_URL);
    const text = await res.text();

    if (text.includes("Kiroflix bot is alive! 🌟")) {
      console.log(
        `✅ Self-ping OK | status: ${res.status} | message verified`
      );
    } else {
      console.warn(
        `⚠️ Self-ping responded but message mismatch | status: ${res.status}`
      );
    }

  } catch (err) {
    console.error("❌ Self-ping failed:", err.message);
  }
}

/* run every 1 minute */
setInterval(selfPing, 60 * 1000);

/* optional immediate run */
selfPing();
