-- Products sold without stock (services: a game session, a delivery fee, a
-- repair). Additive: existing products keep SERIALIZED or QUANTITY.
ALTER TYPE "StockTrackingMode" ADD VALUE IF NOT EXISTS 'SERVICE';
