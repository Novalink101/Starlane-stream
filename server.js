require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();

// 1. Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 2. Firebase Admin Initialization (Safely wrapped)
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // Fix newlines in private key for Render
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log("✅ Firebase Admin Initialized");
} catch (error) {
  console.error("❌ Firebase Admin Error (Server will still run):", error.message);
}

// ==========================================
// API ROUTES
// ==========================================

// --- [ YOCO PAYMENT: CREATE CHECKOUT ] ---
app.post('/api/create-yoco-checkout', async (req, res) => {
  try {
    const { orderId, userId, userEmail, price, returnUrl } = req.body;

    if (!orderId || !userId || !price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const domainUrl = process.env.FRONTEND_URL || 'https://your-forestbase-domain.com';

    const yocoRes = await fetch('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: Math.round(price * 100), // Convert Rands to cents
        currency: 'ZAR',
        cancelUrl: returnUrl || `${domainUrl}/checkout.html`,
        successUrl: returnUrl || `${domainUrl}/account.html`,
        failureUrl: returnUrl || `${domainUrl}/checkout.html`,
        metadata: { 
          orderId: orderId, 
          userId: userId, 
          userEmail: userEmail 
        }
      })
    });

    const yocoData = await yocoRes.json();

    if (!yocoRes.ok) {
      throw new Error(yocoData.message || 'Yoco rejected the request');
    }

    res.json({ redirectUrl: yocoData.redirectUrl });

  } catch (err) {
    console.error('[Yoco Checkout Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- [ YOCO PAYMENT: WEBHOOK ] ---
// ⚠️ IMPORTANT: Add this URL to your Yoco Dashboard: https://your-render-url.onrender.com/api/yoco-webhook
app.post('/api/yoco-webhook', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    
    const event = req.body;

    // Ignore failed payments
    if (event.type !== 'payment.succeeded') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const meta = event.payload.metadata || {};
    const { orderId, userId } = meta;

    if (!userId || !orderId) {
      return res.status(400).json({ error: 'Missing metadata' });
    }

    // 1. Mark the e-commerce ORDER as paid in Firestore
    await db.collection('orders').doc(orderId).update({
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      yocoPaymentId: event.payload.id
    }).catch(e => console.log('Order doc not found:', e));

    // 2. Log the payment success
    console.log(`✅ [Webhook] Order ${orderId} marked as PAID for User ${userId}`);
    
    // Note: If you need to decrease product inventory, you would query 
    // the items in the order here and decrement their stock in Firestore.

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// STATIC FRONTEND HOSTING (WITH CACHING)
// ==========================================
// Serves HTML files from the current folder and caches them in the browser.
app.use(express.static(__dirname, {
  maxAge: '1d',
  etag: true
}));

// Fallback: If a user goes to the main URL, load index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 FORESTBASE Server running on port ${PORT}`);
});
