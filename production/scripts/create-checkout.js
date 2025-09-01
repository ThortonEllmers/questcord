
// Helper: create a Stripe Checkout Session with guildId/tokens metadata
require('dotenv').config();
const cfg = require('../src/utils/config');
const stripe = require('stripe')(cfg?.billing?.stripe?.secretKey || process.env.STRIPE_SECRET_KEY);

async function main(){
  const guildId = process.argv[2];
  const priceId = process.argv[3] || 'price_token_5';
  const quantity = parseInt(process.argv[4] || '1', 10);
  if (!guildId){
    console.error('Usage: node scripts/create-checkout.js <GUILD_ID> <PRICE_ID> <QTY>');
    process.exit(1);
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: (cfg.web?.publicBaseUrl || 'http://localhost:3000') + '/?success=1',
    cancel_url: (cfg.web?.publicBaseUrl || 'http://localhost:3000') + '/?canceled=1',
    line_items: [{ price: priceId, quantity }],
    metadata: { guildId } // tokens may be computed via tokenProductMap mapping
  });
  console.log('Checkout session url:', session.url);
}
main().catch(e=>{ console.error(e); process.exit(1); });
