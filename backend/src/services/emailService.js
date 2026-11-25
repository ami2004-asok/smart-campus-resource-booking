import nodemailer from 'nodemailer';
import { config } from '../config/environment.js';

let transporter = null;
let etherealAccount = null;

async function getTransporter() {
  if (transporter) return transporter;

  const smtpConfigured =
    config.email.host &&
    config.email.user &&
    config.email.pass &&
    !config.email.user.includes('your_email');

  if (smtpConfigured) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });
    console.log('✅ Email: Using configured SMTP server');
  } else if (config.nodeEnv !== 'production') {
    // Development fallback: Ethereal fake SMTP
    etherealAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: etherealAccount.user,
        pass: etherealAccount.pass,
      },
    });
    console.log('⚠️  Email: No SMTP configured. Using Ethereal (fake email) for development.');
    console.log(`   Ethereal user: ${etherealAccount.user}`);
  } else {
    throw new Error(
      'Email credentials are required in production. Configure RESEND_API_KEY or SMTP_HOST, SMTP_USER, and SMTP_PASS.'
    );
  }

  return transporter;
}

async function sendMail(options) {
  const gmailCredentials = {
    clientId: config.email.gmailClientId,
    clientSecret: config.email.gmailClientSecret,
    refreshToken: config.email.gmailRefreshToken,
  };
  const hasGmailCredentials = Object.values(gmailCredentials).some(Boolean);

  if (hasGmailCredentials) {
    const missingCredentials = Object.entries(gmailCredentials)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingCredentials.length > 0) {
      throw new Error(`Gmail API configuration is incomplete. Missing: ${missingCredentials.join(', ')}`);
    }

    console.log('✅ Email: Using Gmail API');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: gmailCredentials.clientId,
        client_secret: gmailCredentials.clientSecret,
        refresh_token: gmailCredentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenResponse.ok) {
      const details = await tokenResponse.text();
      throw new Error(`Gmail API authentication failed (${tokenResponse.status}): ${details}`);
    }

    const { access_token: accessToken } = await tokenResponse.json();
    const encodedSubject = Buffer.from(options.subject, 'utf8').toString('base64');
    const encodedHtml = Buffer.from(options.html, 'utf8')
      .toString('base64')
      .replace(/.{1,76}/g, '$&\r\n')
      .trim();
    const message = [
      `From: ${config.email.from}`,
      `To: ${options.to}`,
      `Subject: =?UTF-8?B?${encodedSubject}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodedHtml,
    ].join('\r\n');
    const raw = Buffer.from(message, 'utf8').toString('base64url');

    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Email delivery failed (Gmail API ${response.status}): ${details}`);
    }

    return response.json();
  }

  if (config.email.resendApiKey) {
    console.log('✅ Email: Using Resend API');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.from,
        ...options,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Email delivery failed (Resend ${response.status}): ${details}`);
    }

    return response.json();
  }

  const t = await getTransporter();
  const info = await t.sendMail({
    from: config.email.from,
    ...options,
  });

  // In dev mode with Ethereal, log the preview URL
  if (etherealAccount) {
    const previewUrl = nodemailer.getTestMessageUrl(info);
    console.log(`\n📧 Email Preview URL: ${previewUrl}\n`);
  }

  return info;
}

export async function sendOtpEmail(email, otp, name) {
  const subject = 'Verify Your CUSAT Email – Resource Booking System';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px;">
      <h2 style="color: #1e3a5f;">CUSAT Resource Booking</h2>
      <p>Hello ${name},</p>
      <p>Use the following OTP to verify your email address. It expires in <strong>${config.otp.expiryMinutes} minutes</strong>.</p>
      <div style="text-align:center; margin: 32px 0;">
        <span style="font-size: 36px; font-weight: bold; letter-spacing: 12px; color: #1e3a5f;">${otp}</span>
      </div>
      <p style="color: #666; font-size: 13px;">If you did not request this, please ignore this email. Do not share this OTP with anyone.</p>
      <hr style="border: none; border-top: 1px solid #eee;" />
      <p style="color: #999; font-size: 12px;">CUSAT Smart Campus Resource Booking System</p>
    </div>
  `;

  if (config.devLogOtp) {
    console.log(`\n🔑 DEV OTP for ${email}: ${otp}\n`);
  }

  await sendMail({ to: email, subject, html });
}

export async function sendPasswordResetEmail(email, resetToken, name) {
  const resetUrl = `${config.frontendUrl}/reset-password?token=${resetToken}`;
  const subject = 'Reset Your Password – CUSAT Resource Booking';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px;">
      <h2 style="color: #1e3a5f;">CUSAT Resource Booking</h2>
      <p>Hello ${name},</p>
      <p>Click the button below to reset your password. This link expires in <strong>${config.resetTokenExpiryMinutes} minutes</strong>.</p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${resetUrl}" style="background: #1e3a5f; color: white; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-weight: bold;">Reset Password</a>
      </div>
      <p style="color: #666; font-size: 13px;">If the button doesn't work, paste this link in your browser:<br/><a href="${resetUrl}">${resetUrl}</a></p>
      <p style="color: #666; font-size: 13px;">If you did not request a password reset, please ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #eee;" />
      <p style="color: #999; font-size: 12px;">CUSAT Smart Campus Resource Booking System</p>
    </div>
  `;

  await sendMail({ to: email, subject, html });
}
