import { Request, Response } from 'express';
import { z } from 'zod';
import {
  BILLING_CYCLES,
  calculatePricing,
  PRICING_MODULE_KEYS,
} from '../lib/pricing.js';

const PricingSchema = z.object({
  modules: z.array(z.string()).min(1),
  organisationSize: z.enum(['1-10', '11-50', '51-200', '201+']),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']),
});

export const calculatePricingHandler = async (req: Request, res: Response) => {
  try {
    const parsed = PricingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || 'Invalid payload',
      });
    }

    const requestedModules = parsed.data.modules.map((m) => m.toLowerCase());
    const invalid = requestedModules.filter((key) => !PRICING_MODULE_KEYS.includes(key));
    if (invalid.length > 0) {
      return res.status(422).json({
        success: false,
        message: `Unknown module keys: ${invalid.join(', ')}`,
      });
    }

    const breakdown = calculatePricing({
      modules: requestedModules,
      organisationSize: parsed.data.organisationSize,
      billingCycle: parsed.data.billingCycle as keyof typeof BILLING_CYCLES,
    });

    return res.status(200).json({
      success: true,
      data: breakdown,
    });
  } catch (error) {
    console.error('Error calculating pricing:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to calculate pricing',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
