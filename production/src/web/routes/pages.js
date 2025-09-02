const express = require('express');
const path = require('path');
const router = express.Router();

// Terms of Service page
router.get('/terms', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'terms.html'));
});

// Privacy Policy page
router.get('/privacy', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'privacy.html'));
});

// Profile page (own profile)
router.get('/profile', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'profile.html'));
});

// Profile page (other user's profile)
router.get('/profile/:userId', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'profile.html'));
});

// Admin page
router.get('/admin', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'admin.html'));
});

// Server information page
router.get('/server/:guildId', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'server.html'));
});

// Landmark information page
router.get('/landmark/:landmarkId', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'landmark.html'));
});

// Status page for status.questcord.fun subdomain
router.get('/status', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'status.html'));
});

// Root path for status subdomain
router.get('/', (req, res) => {
  // Check if request is for status subdomain
  if (req.headers.host && req.headers.host.startsWith('status.')) {
    res.sendFile(path.join(process.cwd(), 'web', 'public', 'status.html'));
  } else {
    // Continue to normal SPA routing
    res.sendFile(path.join(process.cwd(), 'web', 'public', 'index.html'));
  }
});

// Catch-all to serve SPA (but exclude known paths)
router.get('/:guildId([0-9]+)', (req,res)=> res.sendFile(path.join(process.cwd(), 'web', 'public', 'index.html')));

module.exports = router;
