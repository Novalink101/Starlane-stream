const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (your HTML, CSS, JS)
app.use(express.static(path.join(__dirname, './')));

// A simple test route
app.get('/api/health', (req, res) => {
  res.json({ status: 'Starlane Backend is running 🚀' });
});

app.listen(PORT, () => {
  console.log(`🚀 Starlane server running on port ${PORT}`);
});
