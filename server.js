require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

// ==========================================
// 1. MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/yoco-webhook')) {
      req.rawBody = buf;
    }
  }
}));

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ==========================================
// 2. THIRD-PARTY CONFIGURATIONS
// ==========================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS 
  }
});

let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log("✅ Firebase Admin Initialized");
} catch (error) {
  console.error("❌ Firebase Admin Error:", error.message);
}

// ==========================================
// 3. HELPER FUNCTIONS
// ==========================================

// 🔥 We made the email logic a shared function so both the Webhook and the Success Page can use it.
async function sendReceiptEmail(orderId, orderData) {
  try {
    if (!orderData || !orderData.buyerEmail) return;

    let itemsHtml = '';
    orderData.items.forEach(item => {
      itemsHtml += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">
            <img src="${item.imageUrl}" width="50" style="border-radius: 8px; vertical-align: middle; margin-right: 10px;">
            ${item.name} (x${item.quantity})
          </td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">R ${(item.price * item.quantity).toFixed(2)}</td>
        </tr>
      `;
    });

    const mailOptions = {
      from: '"FORESTBASE" <' + process.env.EMAIL_USER + '>',
      to: orderData.buyerEmail,
      subject: `Order Confirmed #${orderId.slice(0, 8).toUpperCase()}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #fff; border: 1px solid #eee; border-radius: 16px; overflow: hidden;">
          <div style="background: #030407; padding: 30px; text-align: center;">
            <h1 style="color: #A3FF12; margin: 0; font-size: 28px;">FORESTBASE</h1>
          </div>
          <div style="padding: 30px;">
            <h2 style="color: #111827; margin-top: 0;">Order Confirmed!</h2>
            <p style="color: #6B7280; font-size: 16px;">Thank you for shopping in the forest. Your mystery is on its way.</p>
            <table style="width: 100%; margin: 20px 0; text-align: left; border-collapse: collapse;">
              ${itemsHtml}
              <tr>
                <td style="padding: 20px 10px 10px; font-weight: bold;">Total</td>
                <td style="padding: 20px 10px 10px; text-align: right; font-weight: bold; color: #059669; font-size: 20px;">R ${orderData.total.toFixed(2)}</td>
              </tr>
            </table>
            <div style="background: #F1F3F7; padding: 20px; border-radius: 10px; margin-top: 20px;">
              <h4 style="margin: 0 0 10px; color: #111827;">Delivery Details</h4>
              <p style="margin: 0; color: #6B7280; font-size: 14px;">
                📍 ${orderData.deliveryAddress}<br>
                📞 ${orderData.deliveryPhone}
              </p>
            </div>
            <div style="text-align: center; margin-top: 30px;">
              <a href="https://forestbase.onrender.com/account.html" style="background: #A3FF12; color: #030407; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Track Your Order</a>
            </div>
          </div>
        </div>
      `
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) console.log('[Email Error]', error);
      else console.log('📧 Email receipt sent to:', orderData.buyerEmail);
    });
  } catch (err) {
    console.log('[Email Helper Error]', err);
  }
}

// ==========================================
// 4. API ROUTES
// ==========================================

// --- [ CLOUDINARY MULTI-IMAGE UPLOAD ] ---
app.post('/api/upload-image', upload.array('images', 3), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No images provided' });
    var imageUrls = [];
    for (var i = 0; i < req.files.length; i++) {
      var file = req.files[i];
      var b64 = Buffer.from(file.buffer).toString('base64');
      var dataURI = "data:" + file.mimetype + ";base64," + b64;
      var result = await cloudinary.uploader.upload(dataURI, { folder: 'forestbase_products', resource_type: 'auto' });
      imageUrls.push(result.secure_url);
    }
    res.json({ success: true, urls: imageUrls });
  } catch (error) {
    console.error('[Cloudinary Error]', error);
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

// --- [ YOCO PAYMENT: CREATE CHECKOUT (SECURE) ] ---
app.post('/api/create-yoco-checkout', async (req, res) => {
  try {
    const { orderId, userId, userEmail, returnUrl } = req.body;
    if (!orderId || !userId) return res.status(400).json({ error: 'Missing required fields' });
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });

    const orderData = orderDoc.data();
    if (orderData.buyerId !== userId) return res.status(403).json({ error: 'Unauthorized order access' });
    if (orderData.status !== 'pending') return res.status(400).json({ error: 'Order already processed' });

    // Server-side math
    var trueTotal = 0;
    if (orderData.items && Array.isArray(orderData.items)) {
      orderData.items.forEach(function(item) {
        trueTotal += (parseFloat(item.price) * parseInt(item.quantity));
      });
    }

    const domainUrl = process.env.FRONTEND_URL || 'https://forestbase.onrender.com';

    const yocoRes = await fetch('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: Math.round(trueTotal * 100),
        currency: 'ZAR',
        cancelUrl: returnUrl || `${domainUrl}/checkout.html`,
        successUrl: returnUrl || `${domainUrl}/account.html`,
        failureUrl: returnUrl || `${domainUrl}/checkout.html`,
        metadata: { orderId, userId, userEmail }
      })
    });
    
    const yocoData = await yocoRes.json();
    if (!yocoRes.ok) throw new Error(yocoData.message || 'Yoco rejected the request');
    
    // 🔥 SAVE YOCO CHECKOUT ID (Used by the Verify endpoint)
    await db.collection('orders').doc(orderId).update({
      yocoCheckoutId: yocoData.id
    });

    res.json({ redirectUrl: yocoData.redirectUrl });
  } catch (err) {
    console.error('[Yoco Checkout Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- [ YOCO PAYMENT: VERIFY PAYMENT (Fallback for slow webhooks) ] ---
app.post('/api/verify-yoco-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const orderData = orderDoc.data();

    // If webhook already caught it, just return success
    if (orderData.status === 'paid') {
      return res.json({ success: true, message: 'Already paid' });
    }

    if (!orderData.yocoCheckoutId) {
      return res.status(400).json({ error: 'No Yoco Checkout ID found for this order.' });
    }

    // Ask Yoco directly
    const yocoRes = await fetch(`https://payments.yoco.com/api/checkouts/${orderData.yocoCheckoutId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`
      }
    });

    if (!yocoRes.ok) throw new Error('Could not reach Yoco API to verify');
    const yocoData = await yocoRes.json();

    // Yoco Checkouts API status is usually 'successful', 'failed', 'cancelled', 'created'
    if (yocoData.status === 'successful') {
      await db.collection('orders').doc(orderId).update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        yocoPaymentId: yocoData.id
      });

      // Send the email since the webhook missed it!
      await sendReceiptEmail(orderId, orderData);
      
      return res.json({ success: true, status: 'paid' });
    } else {
      return res.status(400).json({ error: 'Yoco reports payment is not successful yet. Status: ' + yocoData.status });
    }
  } catch (err) {
    console.error('[Verify Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- [ YOCO PAYMENT: WEBHOOK + EMAIL RECEIPT ] ---
app.post('/api/yoco-webhook', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    // 1. Verify the webhook signature
    const webhookId = req.headers['webhook-id'];
    const webhookTimestamp = req.headers['webhook-timestamp'];
    const webhookSignature = req.headers['webhook-signature'];

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      return res.status(400).json({ error: 'Missing webhook security headers' });
    }

    const payload = `${webhookId}.${webhookTimestamp}.${req.rawBody.toString('utf8')}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.YOCO_SECRET_KEY)
      .update(payload)
      .digest('base64');

    if (expectedSignature !== webhookSignature) {
      console.error('🚨 [Security] Invalid webhook signature detected!');
      return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
    }

    const event = req.body;

    if (event.type !== 'payment.succeeded') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const meta = event.payload.metadata || {};
    const { orderId } = meta;

    if (!orderId) return res.status(400).json({ error: 'Missing order metadata' });

    // 2. Mark order as paid
    await db.collection('orders').doc(orderId).update({
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      yocoPaymentId: event.payload.id
    }).catch(e => console.log('Order not found or already updated'));

    // 3. Send Email
    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (orderDoc.exists) {
      await sendReceiptEmail(orderId, orderDoc.data());
    }

    console.log(`✅ [Webhook] Order ${orderId} marked as PAID`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. STATIC FRONTEND HOSTING & FALLBACK
// ==========================================
app.use(express.static(__dirname, { maxAge: '1d', etag: true }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 6. START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 FORESTBASE Server running on port ${PORT}`);
});
