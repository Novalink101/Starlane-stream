require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();

// 1. Middleware
app.use(cors());
// Note: We apply express.json() globally, but Yoco webhooks sometimes require raw body.
// We'll handle the webhook parsing specifically in its route.
app.use(express.json({ limit: '50mb' }));

// 2. Firebase Admin Initialization
// On Render, you must set FIREBASE_SERVICE_ACCOUNT as an environment variable (stringified JSON)
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // Fix newlines in private key (Render sometimes escapes them)
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin Initialized");
} catch (error) {
  console.error("❌ Firebase Admin Error: Make sure FIREBASE_SERVICE_ACCOUNT is set correctly.", error.message);
}

const db = admin.firestore();

// 3. Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 4. Multer Setup (For handling video chunks in memory)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit per chunk
});

// ==========================================
// ROUTES
// ==========================================

// --- [ HEALTH CHECK ] ---
app.get('/', (req, res) => {
  res.json({ status: 'Starlane Stream API is running', time: new Date() });
});

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
        cancelUrl: returnUrl || 'https://starlane-stream.onrender.com/index.html',
        successUrl: returnUrl || 'https://starlane-stream.onrender.com/index.html',
        failureUrl: returnUrl || 'https://starlane-stream.onrender.com/index.html',
        metadata: { checkoutId, userId, streamId, userEmail } // CRITICAL: Tells webhook who to give the pass to
      })
    });

    const yocoData = await yocoRes.json();

    if (!yocoRes.ok) {
      throw new Error(yocoData.message || 'Yoco rejected the request');
    }

    // Return the redirect URL to checkout.html
    res.json({ redirectUrl: yocoData.redirectUrl });

  } catch (err) {
    console.error('[Yoco Checkout Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- [ YOCO PAYMENT: WEBHOOK ] ---
// You must add this URL to your Yoco Dashboard: https://starlane-stream-api.onrender.com/api/yoco-webhook
app.post('/api/yoco-webhook', async (req, res) => {
  try {
    const event = req.body;

    // Only process successful payments
    if (event.type !== 'payment.succeeded') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const meta = event.payload.metadata || {};
    const { checkoutId, userId, streamId } = meta;

    if (!userId || !streamId) {
      console.error('[Webhook] Missing metadata in payload');
      return res.status(400).json({ error: 'Missing metadata' });
    }

    // 1. Mark purchase as paid
    if (checkoutId) {
      await db.collection('purchases').doc(checkoutId).update({
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        yocoPaymentId: event.payload.id
      }).catch(e => console.log('Purchase doc not found, skipping update.'));
    }

    // 2. GRANT THE PASS (Only happens here!)
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
// Verifies if a user has a valid Novalink ticket before letting them watch
app.post('/api/verify-stream', async (req, res) => {
  try {
    const { ticketCode, streamId } = req.body;
    
    if (!ticketCode) return res.status(400).json({ error: 'No ticket code provided' });

    // TODO: Replace this with your actual Novalink API call if needed
    // Example logic:
    // 1. Fetch ticket from Novalink API
    // 2. Check if it's valid and for the correct event
    // 3. Mark as checked-in

    // Mock success response (since your summary said this was working)
    if (ticketCode.startsWith('NOVA-')) {
      // Grant access in Firebase
      // await db.collection('users').doc(userId).collection('passes').doc(streamId).set({...});
      
      res.json({ valid: true, message: 'Ticket verified successfully' });
    } else {
      res.status(401).json({ valid: false, error: 'Invalid ticket code' });
    }

  } catch (err) {
    console.error('[Novalink Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- [ CLOUDINARY CAMERA UPLOAD ] ---
app.post('/api/upload-chunk', upload.single('video'), async (req, res) => {
  try {
    const { eventId, camId } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No video chunk provided' });
    }

    // 1. Check Kill Switch
    // If the Director killed the stream, reject the upload immediately
    const streamDoc = await db.collection('streams').doc(eventId).get();
    if (streamDoc.exists) {
      const streamData = streamDoc.data();
      if (streamData.killedAt) {
        return res.status(423).json({ error: 'Stream has been killed by Director' });
      }
    }

    // 2. Upload to Cloudinary using a stream
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        resource_type: 'video',
        folder: `starlane/${eventId}`,
        public_id: `${camId}_${Date.now()}` // Unique filename for every 2s chunk
      },
      async (error, result) => {
        if (error) {
          console.error('[Cloudinary Upload Error]', error);
          return res.status(500).json({ error: 'Cloudinary upload failed' });
        }

        // 3. Save the new chunk URL to Firebase
        // We overwrite the existing cam URL so watch.html knows what to play next
        const updatePath = `cams.${camId}`;
        await db.collection('streams').doc(eventId).update({
          [updatePath]: result.secure_url,
          lastChunkAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, url: result.secure_url });
      }
    );

    // End the stream with the buffer from Multer
    uploadStream.end(req.file.buffer);

  } catch (err) {
    console.error('[Upload Route Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
