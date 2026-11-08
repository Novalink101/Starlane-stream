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

// 2. Firebase Admin Initialization
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin Initialized");
} catch (error) {
  console.error("❌ Firebase Admin Error:", error.message);
}

const db = admin.firestore();

// 3. Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 4. Multer Setup
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ==========================================
// API ROUTES
// ==========================================

app.post('/api/create-yoco-checkout', async (req, res) => {
  try {
    const { checkoutId, userId, userEmail, streamId, price, returnUrl } = req.body;
    if (!checkoutId || !userId || !streamId || !price) return res.status(400).json({ error: 'Missing fields' });

    const yocoRes = await fetch('https://payments.yoco.com/api/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: Math.round(price * 100),
        currency: 'ZAR',
        cancelUrl: returnUrl || 'https://starlane-stream.onrender.com/index.html',
        successUrl: returnUrl || 'https://starlane-stream.onrender.com/index.html',
        failureUrl: returnUrl || 'https://starlane-stream.onrender.com/index.html',
        metadata: { checkoutId, userId, streamId, userEmail }
      })
    });
    const yocoData = await yocoRes.json();
    if (!yocoRes.ok) throw new Error(yocoData.message || 'Yoco rejected');
    res.json({ redirectUrl: yocoData.redirectUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/yoco-webhook', async (req, res) => {
  try {
    const event = req.body;
    if (event.type !== 'payment.succeeded') return res.status(200).json({ received: true });

    const meta = event.payload.metadata || {};
    const { checkoutId, userId, streamId } = meta;

    if (userId && streamId) {
      if (checkoutId) {
        await db.collection('purchases').doc(checkoutId).update({
          status: 'paid',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          yocoPaymentId: event.payload.id
        }).catch(e => console.log('Purchase doc not found'));
      }
      await db.collection('users').doc(userId).collection('passes').doc(streamId).set({
        streamId, status: 'approved', purchasedAt: admin.firestore.FieldValue.serverTimestamp(), checkoutId
      }, { merge: true });
      console.log(`✅ Pass granted for ${userId}`);
    }
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/verify-stream', async (req, res) => {
  try {
    const { ticketCode } = req.body;
    if (!ticketCode) return res.status(400).json({ error: 'No ticket code' });
    if (ticketCode.startsWith('NOVA-')) res.json({ valid: true });
    else res.status(401).json({ valid: false, error: 'Invalid ticket' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-chunk', upload.single('video'), async (req, res) => {
  try {
    const { eventId, camId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No video chunk' });

    const streamDoc = await db.collection('streams').doc(eventId).get();
    if (streamDoc.exists && streamDoc.data().killedAt) {
      return res.status(423).json({ error: 'Stream killed' });
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: 'video', folder: `starlane/${eventId}`, public_id: `${camId}_${Date.now()}` },
      async (error, result) => {
        if (error) return res.status(500).json({ error: 'Cloudinary failed' });
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
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// STATIC FRONTEND HOSTING (ROOT DIRECTORY)
// ==========================================
// This tells Express: "Look in the exact same folder as server.js for HTML files"
app.use(express.static(__dirname));

// Fallback: If a user goes to the main URL, load index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
