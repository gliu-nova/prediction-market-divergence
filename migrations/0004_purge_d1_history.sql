-- One-time cleanup: move historical Polymarket detail to R2 instead of D1.
-- Run after UTC midnight when D1 daily write quota has reset:
--   npm run db:purge-history
DELETE FROM poly_price_snapshots;
DELETE FROM poly_order_book_snapshots;
DELETE FROM poly_trades;