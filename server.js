require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

// --- [ YOCO PAYMENT: CREATE CHECKOUT ] ---
app.post('/api/create-yoco-checkout', async (req, res) => {
  try {
    const { orderId, userId, userEmail, price, returnUrl } = req.body;
    if (!orderId || !userId || !price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const domainUrl = process.env.FRONTEND_URL || 'https://forestbase.onrender.com';
    
    const yocoRes = await fetch('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: Math.round(price * 100),
        currency: 'ZAR',
        cancelUrl: returnUrl || `${domainUrl}/checkout.html`,
        successUrl: returnUrl || `${domainUrl}/account.html`,
        failureUrl: returnUrl || `${domainUrl}/checkout.html`,
        metadata: { orderId, userId, userEmail }
      })
    });
    const yocoData = await yocoRes.json();
    if (!yocoRes.ok) throw new Error(yocoData.message || 'Yoco rejected the request');
    res.json({ redirectUrl: yocoData.redirectUrl });
  } catch (err) {
    console.error('[Yoco Checkout Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- [ YOCO PAYMENT: WEBHOOK ] ---
app.post('/api/yoco-webhook', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const event = req.body;
    if (event.type !== 'payment.succeeded') return res.status(200).json({ received: true, ignored: true });

    const meta = event.payload.metadata || {};
    const { orderId, userId } = meta;

    if (orderId) {
      await db.collection('orders').doc(orderId).update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        yocoPaymentId: event.payload.id
      }).catch(e => console.log('Order doc not found'));
    }

    console.log(`✅ [Webhook] Order ${orderId} marked as PAID for User ${userId}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// STATIC FRONTEND HOSTING (CRUCIAL FOR LOGIN.HTML)
// ==========================================
app.use(express.static(__dirname, { maxAge: '1d', etag: true }));

// Fallback for SPA (Only triggers if the file doesn't exist)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
