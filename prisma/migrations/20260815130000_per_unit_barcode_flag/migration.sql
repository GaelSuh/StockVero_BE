-- Does each unit of this product carry its own barcode?
--
-- Cannot be inferred: a phone box has a unique IMEI barcode per handset, while
-- every solar panel of one model shares a single product barcode. Receiving
-- stock asks once per product and stores the answer here. NULL means unanswered.
ALTER TABLE "inventory_categories" ADD COLUMN "has_unique_per_unit_barcode" BOOLEAN;
