require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

let sock;
let isClientReady = false;

// Vercel يستخدم مجلد /tmp للكتابة
const SESSION_PATH = path.join('/tmp', 'whatsapp_session');
if (!fs.existsSync(SESSION_PATH)) {
    fs.mkdirSync(SESSION_PATH, { recursive: true });
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    console.log('🚀 بدء الاتصال بواتساب...');
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('📱 امسح هذا الرمز باستخدام واتساب:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            isClientReady = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isClientReady = true;
            console.log('🎉 تم الاتصال بواتساب بنجاح!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// استدعاء دالة الاتصال عند بدء تشغيل الدالة
connectToWhatsApp().catch(err => console.error("❌ فشل غير متوقع:", err));

// --- API Endpoints ---
app.get('/api/status', (req, res) => {
    res.json({ success: true, clientReady: isClientReady });
});

app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ success: false, message: 'رقم الهاتف والرسالة مطلوبان' });
    if (!isClientReady) return res.status(503).json({ success: false, message: 'عميل واتساب غير جاهز' });
    try {
        const jid = `${number}@s.whatsapp.net`;
        const [result] = await sock.onWhatsApp(jid);
        if (!result?.exists) return res.status(400).json({ success: false, message: 'رقم الهاتف غير مسجل' });
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'تم إرسال الرسالة بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في إرسال الرسالة:', error);
        res.status(500).json({ success: false, message: 'فشل في إرسال الرسالة' });
    }
});

// Vercel يتولى تشغيل الخادم، لذلك نصدر التطبيق فقط
module.exports = app;
