# Order reference display and dashboard review

Orders, USSD and Communication display EDUPAY followed by the existing six-digit
customer code, with no hyphen. Accept both old and new branded formats on input.
Existing UUID/provider references, phone-scoped retrieval, stored codes and
payment verification remain unchanged. No migration, transaction or retry changes.
Validation covers both branded forms and malformed references; display formatting
never reveals voucher credentials. Complexity remains linear in bounded inputs.

Dashboard gross sales sums snapshotted order totals for payment applications in
[from,to). If dates are omitted, the API uses a rolling previous 24 hours.
Consequently sales can decrease when earlier payments leave that window.
This is a possible explanation, not proof of the reported GHS 80 to GHS 61.60.
The exact card, request window and observation times are needed to reconcile it.
Do not rewrite financial history or change reporting periods without that evidence.

Admin SMS/email stock alerts and paid waiting acknowledgements remain a separate
outstanding request. Admin alert destinations have not yet been supplied.

Approved reporting change: dashboard without dates now includes all sales since
launch (all stored payment applications, bounded above by request time). Optional
range=all is explicit; mixing it with dates is rejected. Explicit from/to remain
validated for nonnegative start and strictly increasing dates; ranges may span multiple years. UI offers Since launch, This month,
3 months, 6 months and inclusive custom calendar dates in Ghana UTC. Calendar
presets include the current month; labels show exact selected dates. Operational
stock/backlog/delivery state counts remain current snapshots, independent of sales
period. Sales aggregates use persisted payment facts and never rewrite history.
All-time aggregate cost grows with paid history; no rows returned unbounded,
monitor dashboard latency and add aggregate projections if measured load requires.
