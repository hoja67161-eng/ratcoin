const TelegramBot = require("node-telegram-bot-api");
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
bot.onText(/\/start(?:\s+(.+))?/, (msg, m) => {
  const ref = m[1] || "";
  bot.sendMessage(msg.chat.id,
    "🐀 Welcome to RATCOIN!\nTap the RAT, upgrade your level with TON and invite friends.\nYou start with 15 RAT.",
    { reply_markup: { inline_keyboard: [[{ text: "🐀 Play RATCOIN", web_app: { url: process.env.APP_URL } }]] } });
  if (ref.startsWith("ref_")) console.log("referral", ref, "->", msg.from.id);
});
