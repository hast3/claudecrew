#!/usr/bin/env node
// Send the owner a Telegram message through the Crew bot.
//   node tools/telegram.js "caption" <file>   photo (.png/.jpg/.jpeg) or document
//   node tools/telegram.js "text"             text only
// Reads secrets/telegram.env directly; never prints the token.
const fs = require('fs');
const path = require('path');

function die(msg) { console.error('telegram: ' + msg); process.exit(1); }

function loadEnv() {
  const file = path.join(__dirname, '..', 'secrets', 'telegram.env');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { die('secrets/telegram.env not found'); }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) die('telegram.env is missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  return env;
}

async function main() {
  const [caption, file] = process.argv.slice(2);
  if (caption === undefined || caption === '') die('usage: node tools/telegram.js "caption" [file]');
  const env = loadEnv();
  const form = new FormData();
  form.append('chat_id', env.TELEGRAM_CHAT_ID);
  let method = 'sendMessage';
  if (file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die('file not found: ' + file);
    const isPhoto = /\.(png|jpe?g)$/i.test(file);
    method = isPhoto ? 'sendPhoto' : 'sendDocument';
    form.append('caption', caption.slice(0, 1024));
    form.append(isPhoto ? 'photo' : 'document', new Blob([fs.readFileSync(file)]), path.basename(file));
  } else {
    form.append('text', caption);
  }
  let data;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', body: form });
    data = await res.json();
  } catch (e) {
    die('request failed (' + String(e.message || e).split(env.TELEGRAM_BOT_TOKEN).join('***') + ')');
  }
  if (!data || data.ok !== true) die('Telegram did not accept it: ' + ((data && data.description) || 'no reply'));
  console.log('sent (' + method + ')');
}
main();
