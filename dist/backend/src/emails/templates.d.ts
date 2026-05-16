export declare function tenantRegistrationReceived(params: {
    ownerName: string;
    orgName: string;
}): string;
export declare function tenantApproved(params: {
    ownerName: string;
    orgName: string;
    loginUrl: string;
}): string;
export declare function tenantDenied(params: {
    ownerName: string;
    orgName: string;
    reason: string;
}): string;
export declare function tenantSuspended(params: {
    ownerName: string;
    orgName: string;
    reason: string;
}): string;
export declare function employeeWelcome(params: {
    employeeName: string;
    orgName: string;
    email: string;
    temporaryPassword: string;
    loginUrl: string;
}): string;
export declare function employeePasswordReset(params: {
    employeeName: string;
    temporaryPassword: string;
}): string;
export declare function forgotPassword(params: {
    name: string;
    otpCode: string;
}): string;
export declare function trialEndingWarning(params: {
    ownerName: string;
    orgName: string;
    trialEndsAt: string;
    billingAmount: string;
    billingCycle: string;
    billingUrl: string;
}): string;
export declare function paymentSuccessful(params: {
    ownerName: string;
    orgName: string;
    amount: string;
    billingCycle: string;
    nextBillingDate: string;
}): string;
export declare function paymentFailed(params: {
    ownerName: string;
    orgName: string;
    amount: string;
    reason: string;
    billingUrl: string;
}): string;
export declare function subscriptionCancelled(params: {
    ownerName: string;
    orgName: string;
    accessEndsAt: string;
}): string;
