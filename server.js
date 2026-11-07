require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

// Initialize Firebase Admin (You will need to add your service account key to Render's env variables)
const admin = require('firebase-admin');
let db;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    // Fallback for local testing if needed
    admin.initializeApp();
  }
  db = admin.firestore();
  console.log('🔥 Firebase Admin initialized');
} catch (error) {
  console.error('⚠️ Firebase Admin init error:', error.message);
}

const app = express();
app.use(cors());
app.use(express.json());

// Serve your white-themed static HTML files
app.use(express.static(path.join(__dirname, './')));

// ── YOCO CHECKOUT API ──────────────────────────────────────────
app.post('/api/create-yoco-checkout', async (req, res) => {
  try {
    const { streamId, price, userEmail } = req.body;

    if (!streamId || !price) {
      return res.status(400).json({ error: 'Missing streamId or price.' });
    }

    if (!process.env.YOCO_SECRET_KEY) {
      return res.status(500).json({ error: 'Yoco Secret Key is missing on the server.' });
    }

    // The URL Yoco will send the user to AFTER they pay
    const successUrl = `https://starlane-stream.onrender.com/watch.html?id=${streamId}&paid=true`;

    console.log(`[Yoco] Creating checkout for Stream ${streamId} | Amount: R${price}`);

    const yocoResponse = await axios.post('https://payments.yoco.com/api/checkouts', {
      amount: parseInt(price) * 100, // Yoco expects cents
      currency: 'ZAR',
      successUrl: successUrl,
      cancelUrl: `https://starlane-stream.onrender.com/watch.html?id=${streamId}`,
      metadata: { streamId, userEmail }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (yocoResponse.data && yocoResponse.data.redirectUrl) {
      return res.json({ redirectUrl: yocoResponse.data.redirectUrl });
    } else {
      throw new Error('No redirect URL returned from Yoco.');
    }

  } catch (error) {
    console.error('❌ Yoco Checkout Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to create Yoco checkout.' });
  }
});

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'Starlane Backend is running 🚀' });
});

// Start Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Starlane server running on port ${PORT}`);
});
