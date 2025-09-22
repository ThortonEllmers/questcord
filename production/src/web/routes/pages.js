/**
 * QuestCord Web Page Routes
 * =========================
 * Handles routing for all static HTML pages in the QuestCord web interface.
 * This file serves the various HTML pages that make up the web application:
 * 
 * **Public Pages:**
 * - Terms of Service and Privacy Policy (legal compliance)
 * - Interactive map (main application interface)
 * - Status page (service health monitoring)
 * 
 * **User-Specific Pages:**
 * - User profiles (own and others)
 * - Server information pages
 * - Landmark detail pages
 * 
 * **Administrative Pages:**
 * - Admin dashboard (restricted access)
 * 
 * **Single Page Application (SPA) Support:**
 * - Catch-all routing for client-side navigation
 * - Subdomain routing for status page
 * - Parameter-based routing for dynamic content
 * 
 * All routes serve static HTML files from the web/public directory.
 * The actual functionality is handled by client-side JavaScript and API calls.
 */

// Import Express framework for creating web page routes
const express = require('express');
// Import path utilities for constructing file paths
const path = require('path');
// Create Express router instance for mounting page routes
const router = express.Router();

/**
 * Terms of Service Page
 * GET /terms
 * Serves the Terms of Service HTML page for legal compliance
 * Required for user agreement and service usage policies
 */
router.get('/terms', (req, res) => {
  // Serve the static terms.html file from the web/public directory
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'terms.html'));
});

/**
 * Privacy Policy Page
 * GET /privacy
 * Serves the Privacy Policy HTML page for legal compliance
 * Details how user data is collected, used, and protected
 */
router.get('/privacy', (req, res) => {
  // Serve the static privacy.html file from the web/public directory
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'privacy.html'));
});

/**
 * User Profile Page (Own Profile)
 * GET /profile
 * Serves the user profile page when accessing their own profile
 * Shows personal statistics, achievements, and account settings
 */
router.get('/profile', (req, res) => {
  // Serve the static profile.html file - client-side JS will determine if it's own profile
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'profile.html'));
});

/**
 * User Profile Page (Other User's Profile)
 * GET /profile/:userId
 * Serves the user profile page for viewing another user's public profile
 * Shows public statistics, achievements, and profile information
 * @param {string} userId - Discord user ID of the profile to display
 */
router.get('/profile/:userId', (req, res) => {
  // Serve the same profile.html - client-side JS will use the userId parameter
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'profile.html'));
});

/**
 * Admin Dashboard Page
 * GET /admin
 * Serves the administrative dashboard for authorized users
 * Provides tools for server management, user moderation, and system monitoring
 * Access control is handled by client-side authentication checks
 */
router.get('/admin', (req, res) => {
  // Serve the admin.html file - authentication is checked client-side
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'admin.html'));
});

/**
 * Discord Server Information Page
 * GET /server/:guildId
 * Serves detailed information page for a specific Discord server
 * Shows server stats, member count, location on map, and boss battles
 * @param {string} guildId - Discord server/guild ID to display information for
 */
router.get('/server/:guildId', (req, res) => {
  // Serve the server.html file - client-side JS will use the guildId parameter
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'server.html'));
});

/**
 * Landmark Information Page
 * GET /landmark/:landmarkId
 * Serves detailed information page for a specific map landmark
 * Shows landmark description, visitors, and related activities
 * @param {string} landmarkId - Unique identifier for the landmark to display
 */
router.get('/landmark/:landmarkId', (req, res) => {
  // Serve the landmark.html file - client-side JS will use the landmarkId parameter
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'landmark.html'));
});

/**
 * Service Status Page
 * GET /status
 * Serves the system status page showing service health and uptime information
 * Used for monitoring QuestCord service availability and performance metrics
 */
router.get('/status', (req, res) => {
  // Serve the dedicated status.html file for system monitoring
  res.sendFile(path.join(process.cwd(), 'web', 'public', 'status.html'));
});

/**
 * Root Path Handler with Subdomain Detection
 * GET /
 * Serves different content based on the requesting subdomain:
 * - status.questcord.fun -> status.html (service monitoring)
 * - questcord.fun -> index.html (main application)
 * Enables subdomain-based routing for different application functions
 */
router.get('/', (req, res) => {
  // Check if the request is coming from the status subdomain
  if (req.headers.host && req.headers.host.startsWith('status.')) {
    // Serve the status page for the status subdomain
    res.sendFile(path.join(process.cwd(), 'web', 'public', 'status.html'));
  } else {
    // Serve the main application SPA for the primary domain
    res.sendFile(path.join(process.cwd(), 'web', 'public', 'index.html'));
  }
});

/**
 * Single Page Application Catch-All Route
 * GET /:guildId (numeric Discord IDs only)
 * Catches numeric guild IDs and serves the main SPA
 * Allows client-side routing to handle Discord server ID URLs
 * Uses regex pattern [0-9]+ to match only numeric Discord IDs
 * @param {string} guildId - Numeric Discord guild ID for client-side routing
 */
router.get('/:guildId([0-9]+)', (req,res)=> res.sendFile(path.join(process.cwd(), 'web', 'public', 'index.html')));

// Export the configured router for mounting in the main web server
module.exports = router;
