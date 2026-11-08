require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');

const app = express();

// 1. Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 2. Firebase Admin Initialization (Safely wrapped so server doesn't crash)
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

// 3. Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 4. Multer Setup (For handling video chunks)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit per chunk
});

// ==========================================
// API ROUTES
// ==========================================

// --- [ YOCO PAYMENT: CREATE CHECKOUT ] ---
app.post('/api/create-yoco-checkout', async (req, res) => {
  try {
    const { checkoutId, userId, userEmail, streamId, price, returnUrl } = req.body;

    if (!checkoutId || !userId || !streamId || !price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const yocoRes = await fetch('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: Math.round(price * 100), // Convert Rands to cents
        currency: 'ZAR',
        cancelUrl: returnUrl || 'https://starlane-stream-api.onrender.com/index.html',
        successUrl: returnUrl || 'https://starlane-stream-api.onrender.com/index.html',
        failureUrl: returnUrl || 'https://starlane-stream-api.onrender.com/index.html',
        metadata: { checkoutId, userId, streamId, userEmail }
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
app.post('/api/yoco-webhook', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    
    const event = req.body;

    if (event.type !== 'payment.succeeded') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const meta = event.payload.metadata || {};
    const { checkoutId, userId, streamId } = meta;

    if (!userId || !streamId) {
      return res.status(400).json({ error: 'Missing metadata' });
    }

    // 1. Mark purchase as paid
    if (checkoutId) {
      await db.collection('purchases').doc(checkoutId).update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        yocoPaymentId: event.payload.id
      }).catch(e => console.log('Purchase doc not found'));
    }

    // 2. GRANT THE PASS
    await db.collection('users').doc(userId).collection('passes').doc(streamId).set({
      streamId: streamId,
      status: 'approved',
      purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      checkoutId: checkoutId
    }, { merge: true });

    console.log(`✅ [Webhook] Pass granted for User ${userId} to Stream ${streamId}`);
    res.status(200).json({ success: true });

  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- [ NOVALINK TICKET BRIDGE ] ---
app.post('/api/verify-stream', async (req, res) => {
  try {
    const { ticketCode } = req.body;
    if (!ticketCode) return res.status(400).json({ error: 'No ticket code provided' });

    if (ticketCode.startsWith('NOVA-')) {
      res.json({ valid: true, message: 'Ticket verified successfully' });
    } else {
      res.status(401).json({ valid: false, error: 'Invalid ticket code' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- [ CLOUDINARY CAMERA UPLOAD ] ---
app.post('/api/upload-chunk', upload.single('video'), async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const { eventId, camId } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No video chunk provided' });
    }

    // Check Kill Switch
    const streamDoc = await db.collection('streams').doc(eventId).get();
    if (streamDoc.exists) {
      if (streamDoc.data().killedAt) {
        return res.status(423).json({ error: 'Stream has been killed by Director' });
      }
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        resource_type: 'video',
        folder: `starlane/${eventId}`,
        public_id: `${camId}_${Date.now()}`
      },
      async (error, result) => {
        if (error) {
          console.error('[Cloudinary Upload Error]', error);
          return res.status(500).json({ error: 'Cloudinary upload failed' });
        }

        const updatePath = `cams.${camId}`;
        await db.collection('streams').doc(eventId).update({
          [updatePath]: result.secure_url,
          lastChunkAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, url: result.secure_url });
      }
    );

    uploadStream.end(req.file.buffer);

  } catch (err) {
    console.error('[Upload Route Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// STATIC FRONTEND HOSTING (WITH CACHING)
// ==========================================
// Serves HTML files from the current folder and caches them in the browser for 1 day.
// This stops the "hell slow" loading after the first visit.
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
  console.log(`🚀 Server running on port ${PORT}`);
});
