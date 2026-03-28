const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================
// M-PESA CONFIGURATION
// ============================================

const MPESA_CONFIG = {
    consumerKey: 'c4rRampY9YWDVa4sPmhs7vTaBKq8FXPTcXpyTBEGVCYAm5AF',
    consumerSecret: 'Oddzizf8kfzoMJ1sQLZeOGpc79GzsjA1MHxnPDSVKAK6G9UkXT1t5v51yVFdJx9Z',
    businessShortCode: '174379',
    passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
    environment: 'sandbox'
};

console.log('🚀 Samtronics Solutions Server Starting...');
console.log('📱 M-Pesa Environment:', MPESA_CONFIG.environment);

// Store active transactions
const activeTransactions = new Map();

// ============================================
// GET ACCESS TOKEN
// ============================================

async function getAccessToken() {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    
    try {
        const response = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            {
                headers: { Authorization: `Basic ${auth}` },
                timeout: 30000
            }
        );
        console.log('✅ Access token obtained');
        return response.data.access_token;
    } catch (error) {
        console.error('❌ Token error:', error.response?.data || error.message);
        throw error;
    }
}

// ============================================
// STK PUSH ENDPOINT
// ============================================

app.post('/api/mpesa/stkpush', async (req, res) => {
    const { phone, amount } = req.body;
    console.log('📱 STK Push:', { phone, amount });
    
    let formattedPhone = phone.toString().replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
    
    try {
        const token = await getAccessToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
        const password = Buffer.from(`174379${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
        
        const callbackUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'samtronics-solutions-co-ke.onrender.com'}/api/mpesa-callback`;
        
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: '174379',
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: Math.round(amount),
                PartyA: formattedPhone,
                PartyB: '174379',
                PhoneNumber: formattedPhone,
                CallBackURL: callbackUrl,
                AccountReference: 'Samtronics Payment',
                TransactionDesc: 'LED Signage Purchase'
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        
        activeTransactions.set(response.data.CheckoutRequestID, {
            phone: formattedPhone,
            amount,
            status: 'pending',
            checkoutRequestID: response.data.CheckoutRequestID
        });
        
        res.json({ success: true, checkoutRequestID: response.data.CheckoutRequestID });
        
    } catch (error) {
        console.error('❌ STK Error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: error.response?.data?.errorMessage || 'Payment failed' });
    }
});

// ============================================
// CALLBACK ENDPOINT
// ============================================

app.post('/api/mpesa-callback', (req, res) => {
    console.log('🔔 Callback received');
    const { Body } = req.body;
    
    if (Body?.stkCallback) {
        const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = Body.stkCallback;
        const transaction = activeTransactions.get(CheckoutRequestID);
        
        if (ResultCode === 0) {
            const metadata = {};
            if (CallbackMetadata?.Item) {
                CallbackMetadata.Item.forEach(item => { metadata[item.Name] = item.Value; });
            }
            console.log('✅ PAYMENT SUCCESS!', { amount: metadata.Amount, receipt: metadata.MpesaReceiptNumber });
            if (transaction) transaction.status = 'completed';
        } else {
            console.log('❌ PAYMENT FAILED:', ResultDesc);
            if (transaction) transaction.status = 'failed';
        }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ============================================
// STATUS ENDPOINT
// ============================================

app.post('/api/mpesa/status', async (req, res) => {
    const { checkoutRequestID } = req.body;
    
    const local = activeTransactions.get(checkoutRequestID);
    if (local && local.status !== 'pending') {
        return res.json({ ResultCode: local.status === 'completed' ? 0 : 1, ...local });
    }
    
    try {
        const token = await getAccessToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
        const password = Buffer.from(`174379${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
        
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
            {
                BusinessShortCode: '174379',
                Password: password,
                Timestamp: timestamp,
                CheckoutRequestID: checkoutRequestID
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================
// SERVE FRONTEND
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📍 Main URL: https://samtronics-solutions-co-ke.onrender.com`);
    console.log(`📱 M-Pesa: ${MPESA_CONFIG.environment}`);
});
