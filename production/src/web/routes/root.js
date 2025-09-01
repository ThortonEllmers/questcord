module.exports = function root(app){
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  // Let pages/static handle '/'; no redirect here
};
