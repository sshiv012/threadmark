# Ticket #1078 — Need to revoke external access immediately

From: marta.silva@helio.example
Urgent — we shared a logistics KPI dashboard externally with a contractor whose engagement just ended today. I need to kill their access to that shared link right now. The dashboard has operational volumes and some customer names in it. How fast can I revoke, and does revoking cut off anyone mid-session?

From: Jordan Lee
Hi Marta — you can revoke immediately. Go to the dashboard → Share → Manage links, find the contractor's link, and click Revoke. Revocation takes effect within seconds: the next request is rejected, and any open session is invalidated on their next navigation or data refresh (sessions don't stay live indefinitely). Revoked links can't be reactivated — you'd generate a fresh one if needed later.

From: marta.silva@helio.example
Done, revoked. Can I confirm they can't still see a cached copy? And is there a record I can hand to our security officer showing when access was granted and cut?

From: Jordan Lee
Good questions. Two things: dashboards shared externally render server-side per request and aren't downloadable by default, so there's no full offline cache — a viewer can't reload data after revoke. For the record, every share event is captured in the Audit Log (Settings → Audit): link created, each viewer access with timestamp and IP, and the revoke event with the acting user. You can export that as CSV.

From: tom.becker@helio.example
Tom here, Helio security. I pulled the audit export — it shows the contractor's 14 accesses and the revoke at 15:42 today. Two asks: (1) can we get email alerts when an external link is accessed from a new IP or country, and (2) does the export note whether watermarking was on for their views?

From: Priya Nair
Thanks Tom. Watermarking status per view is in the audit metadata — I'll point you to the column. New-IP/geo access alerts for external links aren't available yet; I've filed THREAD-2260 to add configurable anomaly alerts. For now the daily audit digest is the closest thing. Glad the revoke landed cleanly.
