const BRAND_COLOR = '#0EA5E9';
const BRAND_NAME = 'StockVero';
function baseTemplate(title, body, buttonUrl, buttonText) {
    const buttonHtml = buttonUrl && buttonText ? `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0;">
      <tr>
        <td align="center" bgcolor="${BRAND_COLOR}" style="border-radius: 6px;">
          <a href="${buttonUrl}" target="_blank" style="display: inline-block; padding: 12px 24px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 6px;">
            ${buttonText}
          </a>
        </td>
      </tr>
    </table>
  ` : '';
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #ffffff;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px;">
          <tr>
            <td align="center" style="padding: 0 0 32px 0;">
              <span style="font-size: 24px; font-weight: 700; color: ${BRAND_COLOR};">${BRAND_NAME}</span>
            </td>
          </tr>
          <tr>
            <td align="left" style="padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
              <h1 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #1f2937; text-align: center;">${title}</h1>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #4b5563;">${body}</p>
              ${buttonHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 24px 0 0 0;">
              <p style="margin: 0; font-size: 14px; color: #9ca3af;">${BRAND_NAME} — Inventory & Business Management</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
function monospaceBox(content) {
    return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 16px 0;">
      <tr>
        <td align="center" style="padding: 12px; background-color: #f3f4f6; border-radius: 6px; font-family: monospace; font-size: 16px; font-weight: 600; color: #1f2937;">
          ${content}
        </td>
      </tr>
    </table>
  `;
}
function otpBox(otp) {
    return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 16px 0;">
      <tr>
        <td align="center" style="padding: 16px; background-color: #f0f9ff; border: 2px solid ${BRAND_COLOR}; border-radius: 8px; font-family: monospace; font-size: 28px; font-weight: 700; color: ${BRAND_COLOR}; letter-spacing: 4px;">
          ${otp}
        </td>
      </tr>
    </table>
  `;
}
export function tenantRegistrationReceived(params) {
    const { ownerName, orgName } = params;
    const body = `Hi ${ownerName}, thank you for registering ${orgName}. Your account is currently under review. We will notify you once it has been approved. This usually takes less than 24 hours.`;
    return baseTemplate('We received your registration — StockVero', body);
}
export function tenantApproved(params) {
    const { ownerName, orgName, loginUrl } = params;
    const body = `Hi ${ownerName}, great news — your account for ${orgName} has been approved. You can now log in and start using the platform.`;
    return baseTemplate('Your StockVero account has been approved', body, loginUrl, 'Log In Now');
}
export function tenantDenied(params) {
    const { ownerName, orgName, reason } = params;
    const body = `Hi ${ownerName}, unfortunately we were unable to approve the registration for ${orgName} at this time. Reason: ${reason}. If you believe this is an error or would like to reapply, please contact our support team.`;
    return baseTemplate('Update on your StockVero registration', body);
}
export function tenantSuspended(params) {
    const { ownerName, orgName, reason } = params;
    const body = `Hi ${ownerName}, your account for ${orgName} has been suspended. Reason: ${reason}. Please contact support to resolve this.`;
    return baseTemplate('Your StockVero account has been suspended', body);
}
export function employeeWelcome(params) {
    const { employeeName, orgName, email, temporaryPassword, loginUrl } = params;
    const body = `Hi ${employeeName}, your account for ${orgName} has been created. Here are your login details: Email: ${email}, Temporary Password: ${temporaryPassword}. You will be asked to change your password on first login.${monospaceBox(temporaryPassword)}`;
    return baseTemplate('Your StockVero employee account is ready', body, loginUrl, 'Log In Now');
}
export function employeePasswordReset(params) {
    const { employeeName, temporaryPassword } = params;
    const body = `Hi ${employeeName}, your password has been reset by your administrator. Your new temporary password is: ${temporaryPassword}. Please log in and change it immediately.${monospaceBox(temporaryPassword)}`;
    return baseTemplate('Your StockVero password has been reset', body);
}
export function forgotPassword(params) {
    const { name, otpCode } = params;
    const body = `Hi ${name}, you requested a password reset. Your one-time code is: ${otpCode}. This code expires in 15 minutes. If you did not request this, ignore this email.${otpBox(otpCode)}`;
    return baseTemplate('Your StockVero password reset code', body);
}
export function trialEndingWarning(params) {
    const { ownerName, orgName, trialEndsAt, billingAmount, billingCycle, billingUrl } = params;
    const body = `Hi ${ownerName}, your free trial for ${orgName} ends on ${trialEndsAt}. After that you will be charged ${billingAmount} XAF ${billingCycle}. Make sure your payment details are up to date.`;
    return baseTemplate('Your StockVero trial ends in 3 days', body, billingUrl, 'Manage Billing');
}
export function paymentSuccessful(params) {
    const { ownerName, orgName, amount, billingCycle, nextBillingDate } = params;
    const body = `Hi ${ownerName}, your payment of ${amount} XAF has been confirmed for ${orgName}. Your next billing date is ${nextBillingDate}.`;
    return baseTemplate('Payment confirmed — StockVero', body);
}
export function paymentFailed(params) {
    const { ownerName, orgName, amount, reason, billingUrl } = params;
    const body = `Hi ${ownerName}, we were unable to process your payment of ${amount} XAF for ${orgName}. Reason: ${reason}. Please update your payment details to restore access.`;
    return baseTemplate('Payment failed — action required', body, billingUrl, 'Update Payment Method');
}
export function subscriptionCancelled(params) {
    const { ownerName, orgName, accessEndsAt } = params;
    const body = `Hi ${ownerName}, your subscription for ${orgName} has been cancelled. You will continue to have access until ${accessEndsAt}. After that your account will be deactivated.`;
    return baseTemplate('Your StockVero subscription has been cancelled', body);
}
