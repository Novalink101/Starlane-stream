require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();

// ==========================================
// 1. MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configure Multer (Stores files in memory, max 5MB per file)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } 
});

// ==========================================
// 2. CONFIGURATION (ENVIRONMENT VARIABLES)
// ==========================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

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
  console.error("❌ Firebase Admin Error:", error.message);
}

// ==========================================
// 3. API ROUTES
// ==========================================

// --- [ CLOUDINARY MULTI-IMAGE UPLOAD ] ---
// Accepts up to 3 images under the field name 'images'
app.post('/api/upload-image', upload.array('images', 3), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    var imageUrls = [];

    // Loop through the uploaded files and push to Cloudinary
    for (var i = 0; i < req.files.length; i++) {
      var file = req.files[i];
      
      // Convert buffer to base64
      var b64 = Buffer.from(file.buffer).toString('base64');
      var dataURI = "data:" + file.mimetype + ";base64," + b64;

      // Upload to Cloudinary
      var result = await cloudinary.uploader.upload(dataURI, {
        folder: 'forestbase_products',
        resource_type: 'auto'
      });

      imageUrls.push(result.secure_url);
    }

    // Return the array of secure URLs
    res.json({ success: true, urls: imageUrls });

  } catch (error) {
    console.error('[Cloudinary Multi-Upload Error]', error);
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

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
// ⚠️ IMPORTANT: Add this URL to your Yoco Dashboard: https://forestbase.onrender.com/api/yoco-webhook
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

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. STATIC FRONTEND HOSTING
// ==========================================
// Serves your HTML/CSS/JS files from the root folder
app.use(express.static(__dirname, {
  maxAge: '1d',
  etag: true
}));

// Fallback: If a user goes to an unknown URL, load index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 5. START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 FORESTBASE Server running on port ${PORT}`);
});
