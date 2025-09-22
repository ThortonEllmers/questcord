/**
 * QuestCord Root Route Handler
 * =============================
 * Defines root-level routes that are mounted directly on the main Express app
 * rather than through a router. This provides essential system endpoints
 * that need to be available at the application root level.
 * 
 * **Functionality:**
 * - Health check endpoint for monitoring and load balancer probes
 * - Minimal root-level routing to avoid conflicts with other route handlers
 * 
 * **Design Pattern:**
 * This file exports a function that takes the Express app instance and
 * directly mounts routes on it. This pattern is used for root-level routes
 * that should not be prefixed or grouped with other route modules.
 */

/**
 * Root route configuration function
 * Takes the main Express app instance and mounts essential root-level routes
 * @param {Object} app - Express application instance
 */
module.exports = function root(app){
  /**
   * Health Check Endpoint
   * GET /healthz
   * Provides a simple health check for monitoring services, load balancers,
   * and uptime monitoring tools. Returns a JSON response indicating the
   * web server is operational and responding to requests.
   * 
   * This endpoint is commonly used by:
   * - Kubernetes liveness/readiness probes
   * - Load balancer health checks
   * - Monitoring services (Uptime Robot, etc.)
   * - CI/CD deployment verification
   */
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  
  // Note: Root path ('/') routing is intentionally handled by the pages router
  // to avoid conflicts with Single Page Application routing and static file serving
};
