require('dotenv').config();
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// --- إعداد الخادم ومتغيرات البيئة ---
const app = express();
app.use(express.json());

const { SUPABASE_URL, SUPABASE_KEY, QR_GEN_SECRET } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const SESSION_FILE_PATH = path.join('/tmp', 'whatsapp_session.json');

let sock;
let isClientReady = false;
let qrCodeData = null; // لتخزين رمز QR مؤقتاً

// --- دالة الاتصال الرئيسية (معدلة لـ Vercel) ---
async function connectToWhatsApp() {
    // حذف الجلسة المحلية القديمة (إن وجدت) لضمان استخدام Supabase
    if (fs.existsSync(SESSION_FILE_PATH)) {
        fs.unlinkSync(SESSION_FILE_PATH);
    }
    
    console.log('📥 محاولة تحميل الجلسة من Supabase...');
    const { data: sessionData, error } = await supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('id', 'main_session')
        .single();

    if (sessionData && sessionData.session_data) {
        fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionData.session_data));
        console.log('✅ تم تحميل الجلسة من Supabase بنجاح.');
    } else {
        console.log('ℹ️ لا توجد جلسة محفوظة في Supabase.');
    }

    const { state, saveState } = useSingleFileAuthState(SESSION_FILE_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // سنتحكم في الـ QR بأنفسنا
    });

    // معالج تحديث الاتصال
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📱 تم إنشاء رمز QR جديد.');
            qrCodeData = qr; // حفظ الرمز ليتم عرضه عبر الـ API
        }
        
        if (connection === 'close') {
            isClientReady = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 إعادة الاتصال...');
                connectToWhatsApp();
            } else {
                console.log('🚪 تم تسجيل الخروج.');
                // حذف الجلسة من Supabase عند تسجيل الخروج
                supabase.from('whatsapp_sessions').delete().eq('id', 'main_session').then(() => {
                    console.log('🗑️ تم حذف الجلسة من Supabase.');
                });
            }
        } else if (connection === 'open') {
            isClientReady = true;
            qrCodeData = null;
            console.log('🎉 عميل واتساب جاهز!');
        }
    });

    // معالج حفظ الجلسة
    sock.ev.on('creds.update', async () => {
        await saveState();
        const sessionContent = fs.readFileSync(SESSION_FILE_PATH, { encoding: 'utf-8' });
        console.log('💾 جاري حفظ الجلسة في Supabase...');
        await supabase
            .from('whatsapp_sessions')
            .upsert({ id: 'main_session', session_data: JSON.parse(sessionContent) });
        console.log('✅ تم حفظ الجلسة بنجاح في Supabase.');
    });

    return sock;
}

// --- API Endpoints ---

// نقطة نهاية خاصة ومحمية لإنشاء رمز QR
app.get('/api/generate-qr', async (req, res) => {
    // حماية: تأكد من أن الطلب يحتوي على كلمة سر بسيطة
    if (req.query.secret !== QR_GEN_SECRET) {
        return res.status(403).send('Forbidden: Invalid Secret');
    }
    
    isClientReady = false; // إعادة التعيين
    qrCodeData = null;
    
    // إعادة الاتصال لإنشاء رمز جديد
    await connectToWhatsApp();
    
    // الانتظار لمدة تصل إلى 20 ثانية لظهور الرمز
    let attempts = 0;
    const interval = setInterval(() => {
        if (qrCodeData) {
            clearInterval(interval);
            qrcode.toDataURL(qrCodeData, (err, url) => {
                if (err) return res.status(500).send('Error generating QR code');
                res.send(`<img src="${url}" alt="Scan me with WhatsApp">`);
            });
        } else if (attempts >= 10) { // 10 * 2 ثوان = 20 ثانية
            clearInterval(interval);
            res.status(500).send('Failed to generate QR code in time.');
        }
        attempts++;
    }, 2000);
});

app.post('/api/send', async (req, res) => {
    if (!isClientReady) {
        // محاولة الاتصال تلقائياً إذا لم يكن جاهزاً
        console.log('ℹ️ العميل غير جاهز، محاولة إعادة الاتصال...');
        await connectToWhatsApp();
        return res.status(503).json({ success: false, message: 'عميل واتساب غير جاهز، يرجى المحاولة بعد لحظات' });
    }
    // ... بقية منطق الإرسال ...
    const { number, message } = req.body;
    try {
        const jid = `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'تم إرسال الرسالة بنجاح' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'فشل في إرسال الرسالة' });
    }
});

// تشغيل الاتصال عند بدء تشغيل الدالة
connectToWhatsApp();

module.exports = app;
