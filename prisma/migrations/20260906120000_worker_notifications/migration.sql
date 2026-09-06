-- Wakeups only: durable outbox and delivery rows remain the source of truth.
-- PostgreSQL publishes these static, non-secret topics only after commit.
CREATE FUNCTION edu_notify_outbox_work() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."eventType" IN ('UssdPaymentPromptRequested', 'PaymentSucceeded',
                         'VoucherStockAdded', 'VoucherAllocated') THEN
    PERFORM pg_notify('edu_worker_work', NEW."eventType");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER edu_outbox_work
AFTER INSERT ON "OutboxEvent"
FOR EACH ROW EXECUTE FUNCTION edu_notify_outbox_work();

CREATE FUNCTION edu_notify_delivery_work() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" IN ('PENDING', 'RETRYING') THEN
    PERFORM pg_notify('edu_worker_work', TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER edu_delivery_work
AFTER INSERT OR UPDATE OF "state", "nextAttemptAt" ON "CommunicationDelivery"
FOR EACH ROW EXECUTE FUNCTION edu_notify_delivery_work();

CREATE TRIGGER edu_retrieval_work
AFTER INSERT OR UPDATE OF "state", "nextAttemptAt" ON "VoucherRetrievalEmailDelivery"
FOR EACH ROW EXECUTE FUNCTION edu_notify_delivery_work();
