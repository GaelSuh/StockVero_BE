import { Request, Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const signup: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * GET /api/v1/auth/check-slug?slug=:slug
 * Public. Returns { available: boolean, suggestion?: string }.
 */
export declare const checkSlug: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const login: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const refresh: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const changePassword: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const me: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMe: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const forgotPassword: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Where a verification code can be delivered.
 *
 * Only EMAIL is implemented. A phone channel (SMS or WhatsApp) is expected, and
 * this enum plus sendVerificationCode below are the seam it plugs into: adding
 * one means a new case in that switch and nothing else — the OTP generation,
 * hashing, expiry, cooldown, attempt counting and confirm flow are all
 * channel-agnostic already.
 *
 * Deliberately NOT implemented yet: there is no provider account or approved
 * message template to send through, so any code here would be untestable
 * guesswork. Signup already collects and validates a phone number, so the data
 * needed for it is being captured in the meantime.
 */
export type VerificationChannel = 'EMAIL';
/**
 * POST /api/v1/auth/signup/verification-document
 *
 * Stages the optional business-identity document while the account still does
 * not exist. Three things make this safe to expose without a session:
 *
 *  - It requires the `email_verification` token, so the caller has already
 *    proved control of the address. It is never anonymous, and the token
 *    expires in 10 minutes.
 *  - The object goes to the PRIVATE bucket, so the returned path is not
 *    fetchable by URL. Only an authenticated admin can later sign it.
 *  - Type and size are capped before anything is uploaded.
 *
 * Returns the object path, which the client passes to /signup. The account is
 * created from that path — this endpoint writes no database row, because at
 * this point there is no tenant to attach one to.
 */
export declare const uploadSignupVerificationDocument: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * POST /api/v1/auth/verify-email/request
 *
 * Sends a 6-digit code to the address the owner gave, so they can prove they
 * control it before the account is created. This is what stops a mistyped or
 * nonexistent address from locking someone out of a brand-new account.
 */
export declare const requestEmailVerification: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * POST /api/v1/auth/verify-email/confirm
 *
 * Checks the code and, if valid, returns a short-lived token tied to that exact
 * email. The token is what the signup endpoint requires to proceed.
 */
export declare const confirmEmailVerification: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const verifyOtp: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const resetPassword: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
