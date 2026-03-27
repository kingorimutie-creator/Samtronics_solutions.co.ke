// ============================================
// SAMTRONICS SOLUTIONS - BACKEND SERVER
// This file creates a web server that handles:
// 1. Serving your website files (HTML, CSS, JS)
// 2. Processing M-Pesa payments
// 3. Communicating with Safaricom's API
// ============================================

// Import required packages
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

// Create an instance of Express
const app = express();

// ============================================
// MIDDLEWARE
// ============================================

// Enable CORS - allows requests from any domain
app.use(cors());

// Parse JSON data from requests
app.use(express.json());

// Serve static files (HTML, CSS, JS, images) from the current folder
app.use(express.static(path.join(__dirname, '/')));

// ============================================
// M-PESA CONFIGURATION
// ============================================

const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || '7Ve5y5c180Zwbd8qHEGIp4ROTe1wBSnhAtL3c6AGbS7AAdhQ',
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || 'kJqcTHi82hANEoMVDzRkrz16Qrh4ik9kVBZhsG9eh4JT5rtSlieIUhXIKyQeeNLJ',
  businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE || '174379',
  passkey: process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  environment: process.env.NODE_ENV || 'sandbox'
};

// Store active transactions
const activeTransactions = new Map();

console.log('🚀 Server starting...');
console.log('📱 Environment:', MPESA_CONFIG.environment);

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
        }
      }
    );
    
    console.log('✅ Access token obtained successfully');
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
  
  console.log('📱 STK Push request:', { phone, amount });
  
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
    
    // Get the callback URL
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
    
    const response = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      requestData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
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
        }
      }
    );
    
    res.json(response.data);
  } catch (error) {
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
    transactions: activeTransactions.size
  });
});

// ============================================
// Serve Frontend Files
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// START THE SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📱 Environment: ${MPESA_CONFIG.environment}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    console.log(`🌍 Production URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
  }
});
