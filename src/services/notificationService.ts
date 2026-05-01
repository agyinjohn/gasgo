import axios from 'axios';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Send Firebase Cloud Messaging push notification.
 */
export async function sendPushNotification(fcmToken: string, payload: PushPayload): Promise<void> {
  try {
    await axios.post(
      'https://fcm.googleapis.com/fcm/send',
      {
        to: fcmToken,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
      },
      {
        headers: {
          Authorization: `key=${process.env.FCM_SERVER_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('[FCM] Push notification failed:', err);
  }
}

/**
 * Send SMS via Arkesel (Ghana) with Twilio fallback.
 */
export async function sendSMS(phone: string, message: string): Promise<void> {
  try {
    await sendArkeselSMS(phone, message);
  } catch {
    try {
      await sendTwilioSMS(phone, message);
    } catch (err) {
      console.error('[SMS] Both providers failed:', err);
    }
  }
}

async function sendArkeselSMS(phone: string, message: string): Promise<void> {
  await axios.post(
    'https://sms.arkesel.com/api/v2/sms/send',
    {
      sender: process.env.ARKESEL_SENDER_ID || 'GasGo',
      message,
      recipients: [phone],
    },
    {
      headers: { 'api-key': process.env.ARKESEL_API_KEY },
    }
  );
}

async function sendTwilioSMS(phone: string, message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('Twilio credentials missing');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({
    From: process.env.TWILIO_PHONE_NUMBER!,
    To: phone,
    Body: message,
  });

  await axios.post(url, params.toString(), {
    auth: { username: accountSid, password: authToken },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

// ─── Notification Templates ───────────────────────────────────────────────────

export const SMS_TEMPLATES = {
  otpVerification: (code: string) =>
    `Your GasGo verification code is: ${code}. Valid for 10 minutes. Do not share this code.`,

  orderPlaced: (orderId: string) =>
    `Your GasGo order #${orderId.slice(-6).toUpperCase()} has been placed. We're finding you a rider.`,

  riderAssigned: (riderName: string, eta: string) =>
    `Your rider ${riderName} has accepted your order. ETA: ${eta}.`,

  orderDelivered: (orderId: string) =>
    `Order #${orderId.slice(-6).toUpperCase()} delivered! Thank you for using GasGo.`,

  orderCancelled: () =>
    `Your GasGo order has been cancelled. A refund will be processed within 24 hours if applicable.`,
};

export const ORDER_STATUS_MESSAGES: Record<string, { title: string; body: string }> = {
  accepted: {
    title: 'Rider Found!',
    body: 'A rider has accepted your order and is heading to the station.',
  },
  at_station: {
    title: 'Order Being Prepared',
    body: 'Your rider is at the station collecting your cylinder.',
  },
  en_route: {
    title: 'On the Way!',
    body: 'Your gas is on its way. Track your rider on the map.',
  },
  delivered: {
    title: 'Delivered!',
    body: 'Your gas has been delivered. Please rate your experience.',
  },
  cancelled: {
    title: 'Order Cancelled',
    body: 'Your order has been cancelled. A refund will be processed if applicable.',
  },
};
