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
app.use(express.static(path.join(__dirname, '/')));

// ============================================
// M-PESA CONFIGURATION - UPDATED WITH YOUR CREDENTIALS
// ============================================

const MPESA_CONFIG = {
  // Your new consumer key
  consumerKey: 'c4rRampY9YWDVa4sPmhs7vTaBKq8FXPTcXpyTBEGVCYAm5AF',
  
  // Your new consumer secret
  consumerSecret: 'Oddzizf8kfzoMJ1sQLZeOGpc79GzsjA1MHxnPDSVKAK6G9UkXT1t5v51yVFdJx9Z',
  
  // Sandbox Lipa Na M-Pesa Online Shortcode (fixed)
  businessShortCode: '174379',
  
  // Sandbox Passkey (fixed)
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  
  // Environment: sandbox for testing
  environment: 'sandbox'
};

console.log('🚀 Samtronics Solutions Server Starting...');
console.log('📱 M-Pesa Environment:', MPESA_CONFIG.environment);
console.log('💳 Business Shortcode:', MPESA_CONFIG.businessShortCode);
console.log('🔑 Consumer Key Set:', MPESA_CONFIG.consumerKey ? '✅ Yes' : '❌ No');

// Store active transactions
const activeTransactions = new Map();

// ============================================
// FUNCTION: Get Access Token from Safaricom
// ============================================

async function getAccessToken() {
  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  
  try {
    const baseUrl = MPESA_CONFIG.environment === 'production' 
      ? 'https://api.safaricom.co.ke' 
      : 'https://sandbox.safaricom.co.ke';
    
    const response = await axios.get(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`
        },
        timeout: 30000
      }
    );
    
    console.log('✅ M-Pesa access token obtained successfully');
    return response.data.access_token;
    
  } catch (error) {
    console.error('❌ Error getting access token:', error.response?.data || error.message);
    throw new Error('Failed to get access token');
  }
}

// ============================================
// ENDPOINT 1: Initiate STK Push Payment
// ============================================

app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phone, amount, accountReference, transactionDesc } = req.body;
  
  console.log('📱 STK Push request received:', { phone, amount });
  
  // Format phone number to 2547XXXXXXXX
  let formattedPhone = phone.toString().replace(/\D/g, '');
  
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '254' + formattedPhone.substring(1);
  } else if (formattedPhone.startsWith('+')) {
    formattedPhone = formattedPhone.substring(1);
  } else if (!formattedPhone.startsWith('254')) {
    formattedPhone = '254' + formattedPhone;
  }
  
  try {
    const accessToken = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(
      `${MPESA_CONFIG.businessShortCode}${MPESA_CONFIG.passkey}${timestamp}`
    ).toString('base64');
    
    const baseUrl = MPESA_CONFIG.environment === 'production' 
      ? 'https://api.safaricom.co.ke' 
      : 'https://sandbox.safaricom.co.ke';
    
    // Get callback URL
    const callbackUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'samtronics-solutions-co-ke.onrender.com'}/api/mpesa-callback`;
    
    const requestData = {
      BusinessShortCode: MPESA_CONFIG.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.businessShortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference || 'Samtronics Payment',
      TransactionDesc: transactionDesc || 'LED Signage Purchase'
    };
    
    console.log('📤 Sending STK Push to Safaricom...');
    
    const response = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      requestData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    console.log('✅ STK Push successful:', response.data.CheckoutRequestID);
    
    // Store transaction
    activeTransactions.set(response.data.CheckoutRequestID, {
      phone: formattedPhone,
      amount: amount,
      status: 'pending',
      timestamp: new Date(),
      checkoutRequestID: response.data.CheckoutRequestID
    });
    
    res.json({
      success: true,
      checkoutRequestID: response.data.CheckoutRequestID,
      message: 'Payment request sent. Please check your phone to complete payment.'
    });
    
  } catch (error) {
    console.error('❌ STK Push Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.errorMessage || 'Payment request failed. Please try again.'
    });
  }
});

// ============================================
// ENDPOINT 2: M-Pesa Callback
// ============================================

app.post('/api/mpesa-callback', (req, res) => {
  console.log('🔔 M-Pesa Callback received at:', new Date().toISOString());
  
  const { Body } = req.body;
  
  if (Body && Body.stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = Body.stkCallback;
    const transaction = activeTransactions.get(CheckoutRequestID);
    
    if (ResultCode === 0) {
      const metadata = {};
      if (CallbackMetadata && CallbackMetadata.Item) {
        CallbackMetadata.Item.forEach(item => {
          metadata[item.Name] = item.Value;
        });
      }
      
      console.log('✅ PAYMENT SUCCESSFUL!', {
        checkoutRequestID: CheckoutRequestID,
        amount: metadata.Amount,
        receiptNumber: metadata.MpesaReceiptNumber
      });
      
      if (transaction) {
        transaction.status = 'completed';
        transaction.receiptNumber = metadata.MpesaReceiptNumber;
      }
      
    } else {
      console.log('❌ PAYMENT FAILED:', ResultDesc);
      if (transaction) {
        transaction.status = 'failed';
        transaction.error = ResultDesc;
      }
    }
  }
  
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ============================================
// ENDPOINT 3: Check Payment Status
// ============================================

app.post('/api/mpesa/status', async (req, res) => {
  const { checkoutRequestID } = req.body;
  
  const localTransaction = activeTransactions.get(checkoutRequestID);
  if (localTransaction && localTransaction.status !== 'pending') {
    return res.json({
      ResultCode: localTransaction.status === 'completed' ? 0 : 1,
      ResultDesc: localTransaction.status === 'completed' ? 'Success' : localTransaction.error,
      ...localTransaction
    });
  }
  
  try {
    const accessToken = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(
      `${MPESA_CONFIG.businessShortCode}${MPESA_CONFIG.passkey}${timestamp}`
    ).toString('base64');
    
    const baseUrl = MPESA_CONFIG.environment === 'production' 
      ? 'https://api.safaricom.co.ke' 
      : 'https://sandbox.safaricom.co.ke';
    
    const response = await axios.post(
      `${baseUrl}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: MPESA_CONFIG.businessShortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestID
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        timeout: 30000
      }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('❌ Status check error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ============================================
// ENDPOINT 4: Health Check
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: MPESA_CONFIG.environment,
    businessShortcode: MPESA_CONFIG.businessShortCode,
    transactions: activeTransactions.size
  });
});

// ============================================
// TEST M-PESA CONNECTION ENDPOINT
// ============================================

app.get('/api/mpesa-test', async (req, res) => {
  try {
    const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
    
    console.log('Testing M-Pesa connection...');
    console.log('Consumer Key:', MPESA_CONFIG.consumerKey.substring(0, 10) + '...');
    
    const response = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 30000
      }
    );
    
    res.json({ 
      success: true, 
      message: 'M-Pesa API is working!',
      environment: MPESA_CONFIG.environment,
      hasToken: !!response.data.access_token,
      tokenPreview: response.data.access_token ? response.data.access_token.substring(0, 20) + '...' : null
    });
  } catch (error) {
    console.error('Test error:', error.message);
    console.error('Error details:', error.response?.data || error.code);
    res.json({ 
      success: false, 
      message: error.message,
      error: error.response?.data || error.code,
      environment: MPESA_CONFIG.environment
    });
  }
});

// ============================================
// Serve Frontend
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// START THE SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     🏪 Samtronics Solutions - LED Signages Kenya                ║
╠══════════════════════════════════════════════════════════════════╣
║  🚀 Server running on port: ${PORT}                                     
║  📱 M-Pesa Environment: ${MPESA_CONFIG.environment.padEnd(20)} 
║  💳 Business Shortcode: ${MPESA_CONFIG.businessShortCode}
║  💵 Payment: M-Pesa STK Push & Till Number                      
║  🧪 Test endpoint: /api/mpesa-test
║  🌐 Health check: /api/health
╚══════════════════════════════════════════════════════════════════╝
  `);
});

// ============================================
// ERROR HANDLING
// ============================================

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
