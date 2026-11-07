require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');

const app = express();

/* ───────────────────────────────────────────────────────────
   1. MIDDLEWARE & CORS
   ─────────────────────────────────────────────────────────── */
const allowedOrigins = [
    'https://novalink-tickets.onrender.com',
    'https://starlane-stream-api.onrender.com',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('CORS blocked: Origin not allowed'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static HTML files (Starlane website)
app.use(express.static(path.join(__dirname, './')));

// Setup Multer for handling video chunk uploads in memory
const upload = multer({ storage: multer.memoryStorage() });


/* ───────────────────────────────────────────────────────────
   2. FIREBASE ADMIN INITIALIZATION
   ─────────────────────────────────────────────────────────── */
let db; 

try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Parse the JSON string from Render
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        // Fallback to separate variables
        serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        };
    }

    // Fix the private key newlines if they exist in the JSON
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('🔥 Firebase Admin initialized successfully.');
    
} catch (error) {
    console.error('❌ Firebase Admin init error:', error.message);
    console.error('⚠️ SERVER STOPPING: Cannot start without Firebase.');
    process.exit(1);
}

/* ───────────────────────────────────────────────────────────
   3. CLOUDINARY INITIALIZATION
   ─────────────────────────────────────────────────────────── */
try {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true
    });
    console.log('☁️ Cloudinary initialized successfully.');
} catch (error) {
    console.error('❌ Cloudinary init error:', error.message);
}

/* ───────────────────────────────────────────────────────────
   4. BROADCAST: UPLOAD VIDEO CHUNKS
   ─────────────────────────────────────────────────────────── */
app.post('/api/upload-chunk', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No video chunk provided.');
    }

    const { eventId, camId } = req.body;

    if (!eventId || !camId) {
        return res.status(400).send('Missing eventId or camId.');
    }

    try {
        // Upload the chunk to Cloudinary
        const uploadResult = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                { 
                    resource_type: 'video', 
                    folder: `live_streams/${eventId}/${camId}`
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            uploadStream.end(req.file.buffer);
        });

        // Save the latest chunk URL to Firebase
        const updateData = {};
        updateData[`cams.${camId}`] = uploadResult.secure_url;
        
        await db.collection('streams').doc(eventId).update(updateData);

        res.json({ success: true, url: uploadResult.secure_url });
    } catch (error) {
        console.error('❌ Chunk Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

/* ───────────────────────────────────────────────────────────
   5. YOCO CHECKOUT (Starlane PPV)
   ─────────────────────────────────────────────────────────── */
app.post('/api/create-yoco-checkout', async (req, res) => {
    try {
        const { streamId, price, userEmail } = req.body;

        if (!streamId || !price) {
            return res.status(400).json({ error: 'Missing streamId or price.' });
        }

        if (!process.env.YOCO_SECRET_KEY) {
            return res.status(500).json({ error: 'Yoco secret key is not configured.' });
        }

        const successUrl = `https://starlane-stream-api.onrender.com/watch.html?id=${streamId}&paid=true`;

        const yocoResponse = await axios.post('https://payments.yoco.com/api/checkouts', {
            amount: parseInt(price) * 100, // Yoco expects cents
            currency: 'ZAR',
            successUrl: successUrl,
            cancelUrl: `https://starlane-stream-api.onrender.com/watch.html?id=${streamId}`,
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

/* ───────────────────────────────────────────────────────────
   6. NOVALINK STREAM VERIFICATION (Bridge for Novalink Tickets)
   ─────────────────────────────────────────────────────────── */
app.post('/api/verify-stream', async (req, res) => {
    try {
        const { ticketRef } = req.body;
        
        if (!ticketRef) return res.status(400).json({ valid: false, error: 'Missing ticketRef' });

        const ticketsSnapshot = await db.collectionGroup('tickets').where('paymentRef', '==', ticketRef).limit(1).get();

        if (ticketsSnapshot.empty) {
            return res.json({ valid: false, error: 'Ticket not found' });
        }

        const ticketDoc = ticketsSnapshot.docs[0];
        const ticketData = ticketDoc.data();

        if (ticketData.status === 'valid' || ticketData.status === 'used') {
            await ticketDoc.ref.update({
                status: 'checked-in',
                streamVerifiedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ valid: true, guestName: ticketData.guestName || ticketData.name || 'Guest' });
        } 
        
        if (ticketData.status === 'checked-in') {
             return res.json({ valid: true, guestName: ticketData.guestName || ticketData.name || 'Guest' });
        }

        return res.json({ valid: false, error: `Ticket is ${ticketData.status}` });

    } catch (error) {
        console.error('❌ Stream Verify Error:', error.message);
        res.status(500).json({ valid: false, error: 'Internal server error during stream verification.' });
    }
});

/* ───────────────────────────────────────────────────────────
   7. HEALTH CHECK & FALLBACK
   ─────────────────────────────────────────────────────────── */
app.get('/api/health', (req, res) => {
    res.send('Starlane API is running 🚀');
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Starlane server running on port ${PORT}`);
});
