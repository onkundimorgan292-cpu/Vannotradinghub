import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());

// Allow requests from your Vercel frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const KES_RATE = 129.0;
const TILL_NUMBER = '1957147';
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function formatPhone254(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return '';
}

async function getDarajaToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res = await fetch('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get Safaricom access token');
  return data.access_token;
}

// Health check route
app.get('/', (req, res) => {
  res.json({ status: 'Vannotradinghub M-Pesa STK Server Online', till: TILL_NUMBER });
});

// 1. Trigger M-Pesa PIN Prompt (STK Push) for Till 1957147
app.post('/api/mpesa/stk-push', async (req, res) => {
  try {
    const { userId, phone, amountKes, allocateToBot = true } = req.body;
    const partyA = formatPhone254(phone);
    const amount = Math.round(Number(amountKes));

    if (!userId || !partyA || amount < 10) {
      return res.status(400).json({ error: 'Valid userId, phone (07/01/254), and KES amount (>= 10) are required.' });
    }

    const token = await getDarajaToken();
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

    const stkRes = await fetch('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerBuyGoodsOnline',
        Amount: amount,
        PartyA: partyA,
        PartyB: TILL_NUMBER,
        PhoneNumber: partyA,
        CallBackURL: CALLBACK_URL,
        AccountReference: 'Vannotradinghub',
        TransactionDesc: 'Trading Deposit'
      })
    });

    const stkData = await stkRes.json();
    if (stkData.ResponseCode !== '0') {
      return res.status(400).json({ error: stkData.errorMessage || stkData.ResponseDescription || 'STK Push rejected' });
    }

    await sbAdmin.from('transactions').insert({
      user_id: userId,
      tx_type: 'DEPOSIT',
      method: `M-Pesa STK Till ${TILL_NUMBER}`,
      reference: stkData.CheckoutRequestID,
      amount_usd: +(amount / KES_RATE).toFixed(2),
      status: allocateToBot ? 'PENDING_BOT' : 'PENDING_WALLET'
    });

    return res.json({
      ok: true,
      checkoutRequestId: stkData.CheckoutRequestID,
      message: 'M-Pesa PIN prompt sent to phone.'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 2. Receive Safaricom Callback After Client Enters M-Pesa PIN
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    const { CheckoutRequestID, ResultCode, CallbackMetadata } = cb;
    const { data: pendingTx } = await sbAdmin
      .from('transactions')
      .select('*')
      .eq('reference', CheckoutRequestID)
      .single();

    if (!pendingTx) return res.json({ ResultCode: 0, ResultDesc: 'Ignored' });
    if (pendingTx.status === 'COMPLETED') return res.json({ ResultCode: 0, ResultDesc: 'Already credited' });

    if (Number(ResultCode) !== 0) {
      await sbAdmin.from('transactions').update({ status: 'FAILED' }).eq('id', pendingTx.id);
      return res.json({ ResultCode: 0, ResultDesc: 'Recorded failed payment' });
    }

    const items = CallbackMetadata?.Item || [];
    const amountItem = items.find(i => i.Name === 'Amount');
    const receiptItem = items.find(i => i.Name === 'MpesaReceiptNumber');
    const paidKes = Number(amountItem?.Value || 0);
    const receiptCode = String(receiptItem?.Value || CheckoutRequestID);
    const creditedUsd = +(paidKes / KES_RATE).toFixed(2);

    const { data: wallet } = await sbAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', pendingTx.user_id)
      .single();

    if (wallet && creditedUsd > 0) {
      const toBot = pendingTx.status === 'PENDING_BOT';
      await sbAdmin
        .from('wallets')
        .update({
          bot_capital_usd: toBot ? +(Number(wallet.bot_capital_usd) + creditedUsd).toFixed(2) : wallet.bot_capital_usd,
          available_usd: !toBot ? +(Number(wallet.available_usd) + creditedUsd).toFixed(2) : wallet.available_usd,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', pendingTx.user_id);
    }

    await sbAdmin
      .from('transactions')
      .update({
        reference: receiptCode,
        amount_usd: creditedUsd,
        status: 'COMPLETED'
      })
      .eq('id', pendingTx.id);

    return res.json({ ResultCode: 0, ResultDesc: 'Credited' });
  } catch (err) {
    return res.json({ ResultCode: 0, ResultDesc: 'Error logged' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
