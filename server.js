
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// Isi FRONTEND_ORIGIN di Railway dengan URL Netlify kamu.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
      return callback(null, true);
    }
    return callback(new Error("Origin tidak diizinkan."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

let activeBot = null;
let pollingController = null;
let lastError = null;
let lastUpdateId = 0;
let messagesProcessed = 0;
let connectionStartedAt = null;

async function telegramRequest(token, method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.ok !== true) {
    throw new Error(result.description || "Permintaan Telegram gagal.");
  }

  return result.result;
}

async function sendMessage(chatId, text) {
  if (!activeBot) return;

  try {
    await telegramRequest(activeBot.token, "sendMessage", {
      chat_id: chatId,
      text
    });
  } catch (error) {
    lastError = error.message;
    console.error("Gagal mengirim pesan Telegram:", error.message);
  }
}

async function handleUpdate(update) {
  const message = update.message;

  if (!message || !message.chat || typeof message.text !== "string") {
    return;
  }

  const text = message.text.trim();
  const chatId = message.chat.id;

  messagesProcessed++;

  if (text === "/start" || text.startsWith("/start ")) {
    await sendMessage(
      chatId,
      "Halo! 👋\n\nBot kamu sudah terhubung ke YouBot.\n\nKetik /help untuk melihat perintah."
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      chatId,
      "Perintah YouBot:\n/start - Mulai bot\n/help - Bantuan\n\nKirim pesan teks untuk mendapatkan balasan otomatis."
    );
    return;
  }

  if (text.startsWith("/")) {
    await sendMessage(chatId, "Perintah belum tersedia. Ketik /help.");
    return;
  }

  await sendMessage(chatId, `Pesan diterima: ${text}`);
}

async function pollingLoop(bot, controller) {
  while (
    activeBot === bot &&
    pollingController === controller &&
    !controller.signal.aborted
  ) {
    try {
      const updates = await telegramRequest(bot.token, "getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 25,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        if (
          activeBot !== bot ||
          pollingController !== controller ||
          controller.signal.aborted
        ) {
          return;
        }

        lastUpdateId = Math.max(lastUpdateId, update.update_id);

        try {
          await handleUpdate(update);
        } catch (error) {
          lastError = error.message;
          console.error("Gagal memproses pesan:", error.message);
        }
      }

      lastError = null;
    } catch (error) {
      if (controller.signal.aborted || pollingController !== controller) {
        return;
      }

      lastError = error.message;
      console.error("Polling Telegram gagal:", error.message);

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function stopPolling() {
  if (pollingController) {
    pollingController.abort();
  }
  pollingController = null;
}

// Cek apakah backend aktif.
app.get("/", (req, res) => {
  res.json({
    name: "YouBot Backend",
    status: "online"
  });
});

// Cek status backend dan bot.
app.get("/api/status", (req, res) => {
  res.json({
    online: true,
    botVerified: Boolean(activeBot),
    botUsername: activeBot ? activeBot.username : null,
    botFirstName: activeBot ? activeBot.firstName : null,
    polling: Boolean(pollingController),
    messagesProcessed,
    lastError: lastError
      ? "Ada masalah pada koneksi Telegram."
      : null,
    connectedAt: connectionStartedAt
  });
});

// Terima token dari formulir Connect Telegram.
app.post("/api/connect", async (req, res) => {
  const token = typeof req.body?.token === "string"
    ? req.body.token.trim()
    : "";

  if (!token || token.length > 200) {
    return res.status(400).json({
      connected: false,
      message: "Token tidak valid. Periksa token BotFather."
    });
  }

  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    return res.status(400).json({
      connected: false,
      message: "Format token tidak valid. Salin token lengkap dari BotFather."
    });
  }

  try {
    // Verifikasi token sebelum mengganti bot yang aktif.
    const info = await telegramRequest(token, "getMe");

    stopPolling();

    const bot = {
      token,
      id: info.id,
      username: info.username || "",
      firstName: info.first_name || "Telegram Bot"
    };

    activeBot = bot;
    lastUpdateId = 0;
    lastError = null;
    messagesProcessed = 0;
    connectionStartedAt = new Date().toISOString();

    const controller = new AbortController();
    pollingController = controller;

    // Polling berjalan di latar belakang.
    void pollingLoop(bot, controller);

    // Token tidak pernah dikirim kembali ke browser.
    return res.json({
      connected: true,
      bot: {
        id: bot.id,
        username: bot.username,
        firstName: bot.firstName
      }
    });
  } catch (error) {
    console.error("Verifikasi token gagal:", error.message);

    return res.status(400).json({
      connected: false,
      message: "Token gagal diverifikasi. Periksa token dan koneksi Telegram."
    });
  }
});

// Penanganan error.
app.use((err, req, res, next) => {
  if (err.message === "Origin tidak diizinkan.") {
    return res.status(403).json({
      message: "Origin tidak diizinkan."
    });
  }

  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      message: "Format JSON tidak valid."
    });
  }

  console.error("Server error:", err.message);

  res.status(500).json({
    message: "Terjadi kesalahan pada server."
  });
});

app.listen(PORT, () => {
  console.log(`YouBot backend berjalan di port ${PORT}`);
});

