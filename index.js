// نظام API خفيف لإرسال رسائل واتساب باستخدام Baileys
// يركز على تخزين بصمة المصادقة فقط للحصول على أقصى كفاءة

require('dotenv').config();
const express = require('express');
const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    isJidBroadcast,
    proto
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');

// إعدادات الخادم
const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_NAME = process.env.SESSION_NAME || 'whatsapp_session';

// إعداد Express middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// إعداد نظام التسجيل الخفيف
const logger = P({ 
    level: 'warn', // تقليل مستوى التسجيل لتوفير الموارد
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    }
});

// متغيرات حالة النظام
let whatsappClient = null;
let isClientReady = false;
let qrCodeGenerated = false;

/**
 * إنشاء اتصال واتساب جديد
 * يستخدم useMultiFileAuthState لتخزين بصمة المصادقة فقط
 * هذا يضمن حجماً صغيراً جداً للملفات المحفوظة (بالكيلوبايت)
 */
async function createWhatsAppConnection() {
    try {
        console.log('🚀 بدء إنشاء اتصال واتساب...');
        
        // الحصول على أحدث إصدار من Baileys
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📱 استخدام إصدار واتساب: ${version.join('.')}`);
        
        // إعداد حالة المصادقة - تخزين بصمة المصادقة فقط
        // هذا يحفظ فقط: مفاتيح التشفير + بيانات الجهاز + معلومات التسجيل الأولية
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_NAME);
        console.log('🔐 تم تحميل بيانات المصادقة الخفيفة');

        // إنشاء عميل واتساب بإعدادات محسّنة للأداء
        whatsappClient = makeWASocket({
            version,
            auth: state,
            logger: logger,
            printQRInTerminal: false, // نتحكم في عرض QR بأنفسنا
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            // إعدادات لتقليل استهلاك الموارد
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            generateHighQualityLinkPreview: false,
            syncFullHistory: false, // عدم مزامنة السجل الكامل
            browser: ['WhatsApp API', 'Chrome', '4.0.0'],
            // تجاهل رسائل معينة لتوفير الموارد
            shouldHandleMessage: () => false
        });

        // معالج تحديث حالة الاتصال
        whatsappClient.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // عرض رمز QR إذا كان متاحاً
            if (qr && !qrCodeGenerated) {
                console.log('\n📱 امسح رمز QR التالي بتطبيق واتساب:');
                console.log('═'.repeat(50));
                qrcode.generate(qr, { small: true });
                console.log('═'.repeat(50));
                qrCodeGenerated = true;
            }
            
            // معالجة حالات الاتصال المختلفة
            if (connection === 'open') {
                console.log('✅ تم الاتصال بواتساب بنجاح!');
                isClientReady = true;
                qrCodeGenerated = false;
            } else if (connection === 'close') {
                console.log('❌ تم قطع الاتصال مع واتساب');
                isClientReady = false;
                
                // معالجة أسباب قطع الاتصال المختلفة
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log('🔄 محاولة إعادة الاتصال...');
                    setTimeout(() => createWhatsAppConnection(), 5000);
                } else {
                    console.log('🚪 تم تسجيل الخروج - يتطلب رمز QR جديد');
                    qrCodeGenerated = false;
                }
            } else if (connection === 'connecting') {
                console.log('🔄 جاري الاتصال بواتساب...');
            }
        });

        // حفظ بيانات المصادقة عند تحديثها
        // هذا يحفظ فقط البيانات الضرورية لإعادة الاتصال
        whatsappClient.ev.on('creds.update', saveCreds);
        
        // معالج الرسائل المستقبلة (مُعطل لتوفير الموارد)
        whatsappClient.ev.on('messages.upsert', () => {
            // تجاهل الرسائل المستقبلة لتوفير الموارد
        });

        console.log('⚡ تم إعداد عميل واتساب بنجاح');

    } catch (error) {
        console.error('❌ خطأ في إنشاء اتصال واتساب:', error.message);
        // إعادة المحاولة بعد 10 ثواني في حالة الخطأ
        setTimeout(() => createWhatsAppConnection(), 10000);
    }
}

/**
 * التحقق من صحة رقم الهاتف وتنسيقه
 */
function validateAndFormatPhoneNumber(number) {
    // إزالة جميع الرموز غير الرقمية
    let cleanNumber = number.replace(/[^0-9]/g, '');
    
    // إضافة رمز الدولة إذا لم يكن موجوداً
    if (!cleanNumber.startsWith('966') && cleanNumber.length === 9) {
        cleanNumber = '966' + cleanNumber;
    }
    
    // التحقق من صحة الرقم السعودي
    if (cleanNumber.startsWith('966') && cleanNumber.length === 12) {
        return cleanNumber + '@s.whatsapp.net';
    }
    
    // للأرقام الدولية الأخرى
    if (cleanNumber.length >= 10) {
        return cleanNumber + '@s.whatsapp.net';
    }
    
    return null;
}

/**
 * التحقق من وجود رقم في واتساب
 */
async function checkWhatsAppNumber(jid) {
    try {
        const [result] = await whatsappClient.onWhatsApp(jid);
        return result && result.exists;
    } catch (error) {
        console.error('خطأ في التحقق من الرقم:', error.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
//                           API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * نقطة نهاية إرسال الرسائل
 * POST /api/send
 */
app.post('/api/send', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        // التحقق من البيانات المطلوبة
        if (!number || !message) {
            return res.status(400).json({
                success: false,
                message: 'رقم الهاتف والرسالة مطلوبان'
            });
        }
        
        // التحقق من جاهزية العميل
        if (!isClientReady || !whatsappClient) {
            return res.status(503).json({
                success: false,
                message: 'عميل واتساب غير متصل. يرجى المحاولة لاحقاً'
            });
        }
        
        // تنسيق والتحقق من صحة رقم الهاتف
        const formattedJid = validateAndFormatPhoneNumber(number);
        if (!formattedJid) {
            return res.status(400).json({
                success: false,
                message: 'رقم الهاتف غير صحيح'
            });
        }
        
        // التحقق من وجود الرقم في واتساب
        const numberExists = await checkWhatsAppNumber(formattedJid);
        if (!numberExists) {
            return res.status(404).json({
                success: false,
                message: 'رقم الهاتف غير مسجل في واتساب'
            });
        }
        
        // إرسال الرسالة
        await whatsappClient.sendMessage(formattedJid, { 
            text: message 
        });
        
        console.log(`✅ تم إرسال رسالة إلى: ${number}`);
        
        res.json({
            success: true,
            message: 'تم إرسال الرسالة بنجاح'
        });
        
    } catch (error) {
        console.error('❌ خطأ في إرسال الرسالة:', error.message);
        res.status(500).json({
            success: false,
            message: 'خطأ في إرسال الرسالة: ' + error.message
        });
    }
});

/**
 * نقطة نهاية التحقق من حالة النظام
 * GET /api/status
 */
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        isReady: isClientReady,
        message: isClientReady ? 'النظام جاهز' : 'النظام غير متصل'
    });
});

/**
 * نقطة نهاية الصفحة الرئيسية
 */
app.get('/', (req, res) => {
    res.json({
        message: 'نظام API واتساب باستخدام Baileys',
        version: '1.0.0',
        endpoints: {
            'POST /api/send': 'إرسال رسالة',
            'GET /api/status': 'التحقق من الحالة'
        }
    });
});

// معالج الأخطاء العام
app.use((error, req, res, next) => {
    console.error('❌ خطأ في الخادم:', error.message);
    res.status(500).json({
        success: false,
        message: 'خطأ داخلي في الخادم'
    });
});

// بدء الخادم
app.listen(PORT, async () => {
    console.log('═'.repeat(60));
    console.log('🚀 نظام API واتساب - Baileys');
    console.log('═'.repeat(60));
    console.log(`📡 الخادم يعمل على المنفذ: ${PORT}`);
    console.log(`🌐 الرابط المحلي: http://localhost:${PORT}`);
    console.log('═'.repeat(60));
    
    // بدء اتصال واتساب
    await createWhatsAppConnection();
});

// معالج إيقاف النظام بشكل آمن
process.on('SIGINT', () => {
    console.log('\n🛑 جاري إيقاف النظام...');
    if (whatsappClient) {
        whatsappClient.end();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 تم استلام إشارة إنهاء النظام');
    if (whatsappClient) {
        whatsappClient.end();
    }
    process.exit(0);
});