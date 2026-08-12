# EduVoucher domain modules

Create each module only when its approved implementation unit begins. Follow the ownership rules in AGENTS.md:

- catalog
- orders
- payments
- voucher-inventory
- fulfilment
- communication
- stock-monitoring
- reconciliation
- audit
- ussd
- administration

Domain modules own their business tables, invariants, repositories, and write commands. They consume platform contracts but never import provider SDKs or other modules' persistence models directly.
