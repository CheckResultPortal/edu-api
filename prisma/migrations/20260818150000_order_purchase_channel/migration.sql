-- PostgreSQL requires a newly added enum value to be committed before a later
-- migration can safely use it in a constraint.
ALTER TYPE "OrderDeliveryPreference" ADD VALUE IF NOT EXISTS 'EMAIL_ONLY';
