let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

// Configure real delivery via .env (SMTP_HOST/PORT/SECURE/USER/PASS, MAIL_FROM); missing config or a missing nodemailer package falls back to a JSON/console logger so OTP keeps working locally.

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;

const isSmtpConfigured = Boolean(nodemailer && SMTP_HOST && SMTP_USER && SMTP_PASS);

const MAIL_FROM = process.env.MAIL_FROM || `"Zunasoft Smart POS" <${SMTP_USER || 'no-reply@zunasoft.local'}>`;

const transporter = isSmtpConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : nodemailer && nodemailer.createTransport
    ? nodemailer.createTransport({ jsonTransport: true })
    : null;

const verifyMailer = async () => {
  if (!nodemailer) {
    console.log('[Mailer] Nodemailer package not present — operating in console OTP logging mode.');
    return false;
  }

  if (!isSmtpConfigured) {
    console.log('[Mailer] SMTP not configured — OTP emails will be printed to this console only.');
    console.log('[Mailer] Set SMTP_HOST / SMTP_USER / SMTP_PASS in .env to enable real delivery.');
    return false;
  }

  try {
    await transporter.verify();
    console.log(`[Mailer] SMTP ready via ${SMTP_HOST}:${SMTP_PORT} as ${SMTP_USER}`);
    return true;
  } catch (err) {
    console.error(`[Mailer] SMTP verification failed: ${err.message}`);
    console.error('[Mailer] Falling back to console output for OTP codes.');
    return false;
  }
};

const otpTemplate = ({ otp, heading, subtitle, recipientLabel, expiryMinutes }) => `
<div style="background:#f1f5f9;padding:32px 12px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#4f46e5,#06b6d4);padding:28px 32px;color:#ffffff;">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.85;">Zunasoft Smart Retail POS</div>
      <div style="font-size:22px;font-weight:700;margin-top:6px;">${heading}</div>
    </div>

    <div style="padding:32px;">
      <p style="margin:0 0 6px;color:#0f172a;font-size:15px;">Hello ${recipientLabel},</p>
      <p style="margin:0 0 24px;color:#475569;font-size:14px;line-height:1.6;">${subtitle}</p>

      <div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:16px;padding:22px;text-align:center;">
        <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#4338ca;">Your one-time password</div>
        <div style="font-size:38px;font-weight:800;letter-spacing:10px;color:#312e81;margin:12px 0 4px;font-family:'Courier New',monospace;">${otp}</div>
        <div style="font-size:12px;color:#4f46e5;">Expires in ${expiryMinutes} minute${expiryMinutes === 1 ? '' : 's'}</div>
      </div>

      <p style="margin:24px 0 0;color:#64748b;font-size:12px;line-height:1.6;">
        Never share this code. Zunasoft staff will never ask you for it. If you did not request
        this login, you can safely ignore this email — no action was taken on your account.
      </p>
    </div>

    <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px;">
      Automated security message from the Zunasoft Smart POS platform.
    </div>
  </div>
</div>
`;

const sendOtpEmail = async ({ to, otp, expiryMinutes = 10, purpose = 'tenant', recipientLabel = 'there' }) => {
  const isSuperAdmin = purpose === 'superadmin';

  const mail = {
    from: MAIL_FROM,
    to,
    subject: isSuperAdmin
      ? `${otp} is your Super Admin login code`
      : `${otp} is your Smart POS login code`,
    text:
      `Your one-time password is ${otp}. It expires in ${expiryMinutes} minutes. ` +
      `If you did not request this login, ignore this email.`,
    html: otpTemplate({
      otp,
      expiryMinutes,
      recipientLabel,
      heading: isSuperAdmin ? 'Super Admin Console Login' : 'POS Terminal Login',
      subtitle: isSuperAdmin
        ? 'Use the code below to sign in to the Zunasoft Super Admin control panel.'
        : 'Use the code below to sign in to your Smart POS terminal.'
    })
  };

  try {
    if (transporter && isSmtpConfigured) {
      const info = await transporter.sendMail(mail);
      console.log(`[Mailer] OTP email sent to ${to} (messageId: ${info.messageId})`);
      return { delivered: true, messageId: info.messageId };
    }

    console.log(`[Mailer] (console-only) OTP for ${to} → ${otp}`);
    return { delivered: false, reason: isSmtpConfigured ? 'SMTP failure' : 'SMTP not configured' };
  } catch (err) {
    console.error(`[Mailer] Failed to send OTP to ${to}: ${err.message}`);
    console.log(`[Mailer] (fallback) OTP for ${to} → ${otp}`);
    return { delivered: false, reason: err.message };
  }
};

// Fire-and-forget: a failed/unconfigured send never blocks the sale or stock adjustment that triggered it.
const sendLowStockEmail = async ({ to, storeName, product }) => {
  const mail = {
    from: MAIL_FROM,
    to,
    subject: `Low stock: ${product.name} (${product.stock} ${product.unit || ''} left)`,
    text:
      `${product.name} has reached its reorder level at ${storeName || 'your store'}.\n` +
      `Current stock: ${product.stock} ${product.unit || ''}\n` +
      `Reorder level: ${product.minStock} ${product.unit || ''}\n` +
      (product.sku ? `SKU: ${product.sku}\n` : '') +
      `Replenish it soon to avoid a stock-out.`,
    html: `
      <div style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        <div style="background:#f59e0b;padding:20px 24px;color:#ffffff;">
          <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.9;">Reorder Alert</div>
          <div style="font-size:19px;font-weight:700;margin-top:4px;">${product.name}</div>
        </div>
        <div style="padding:24px;color:#0f172a;font-size:14px;line-height:1.7;">
          <p style="margin:0 0 12px;">Stock at <strong>${storeName || 'your store'}</strong> has reached its reorder level.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr><td style="padding:6px 0;color:#64748b;">Current stock</td><td style="padding:6px 0;text-align:right;font-weight:700;">${product.stock} ${product.unit || ''}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;">Reorder level</td><td style="padding:6px 0;text-align:right;">${product.minStock} ${product.unit || ''}</td></tr>
            ${product.sku ? `<tr><td style="padding:6px 0;color:#64748b;">SKU</td><td style="padding:6px 0;text-align:right;">${product.sku}</td></tr>` : ''}
          </table>
        </div>
      </div>
    `
  };

  try {
    if (transporter && isSmtpConfigured) {
      const info = await transporter.sendMail(mail);
      console.log(`[Mailer] Low-stock alert for "${product.name}" sent to ${to} (messageId: ${info.messageId})`);
      return { delivered: true, messageId: info.messageId };
    }
    console.log(`[Mailer] (console-only) Low-stock alert for "${product.name}" → ${to}`);
    return { delivered: false, reason: isSmtpConfigured ? 'SMTP failure' : 'SMTP not configured' };
  } catch (err) {
    console.error(`[Mailer] Failed to send low-stock alert for "${product.name}" to ${to}: ${err.message}`);
    return { delivered: false, reason: err.message };
  }
};

module.exports = {
  transporter,
  sendOtpEmail,
  sendLowStockEmail,
  verifyMailer,
  isSmtpConfigured
};
