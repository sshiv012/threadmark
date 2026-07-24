# Ticket #1130 — Shared dashboard extremely slow on mobile

From: raj.patel@northwind.example
Reporting on behalf of a client viewing one of our externally shared dashboards. On desktop it loads in ~2s, but on mobile (their phones, over cellular) it takes 20–30s and sometimes the charts never render — just spinners. This is a viewer-only shared link, not an embed. Client is on the road a lot so mobile matters. What's going on?

From: Wei Chen
Northwind eng here. I reproduced on a throttled 4G profile. The shared dashboard has 11 widgets and two of them are high-cardinality tables (~8k rows each) that render fully client-side. On mobile the payload is ~4.2MB and the tables block paint. On desktop the CPU/network hides it; on a phone it falls over.

From: Jordan Lee
Thanks Wei — that lines up with what we see for heavy dashboards on the external viewer. A few levers on the sharing side: (1) the external viewer honors a "mobile-optimized" render mode that paginates large tables server-side instead of shipping all rows, (2) you can disable specific heavy widgets for external/mobile viewers under Share settings → Viewer options, and (3) charts lazy-load below the fold. Mobile-optimized mode is off by default on older shared links.

From: raj.patel@northwind.example
So existing shared links don't get mobile optimization automatically? That's a gotcha — this link was created two months ago. Do I need to re-share to pick it up, or is there a toggle?

From: Priya Nair
There's a toggle — no need to re-share. Open the link in Manage links → Viewer options → enable "Mobile-optimized rendering" and "Server-side table pagination." That flips it for the existing link immediately. We're also changing the default so newly created external links have mobile optimization on out of the box (THREAD-2288). Separately, Wei, those two 8k-row tables would benefit from a server-side aggregation even on desktop — happy to look at the query.

From: raj.patel@northwind.example
Enabled both toggles. Client just confirmed mobile load is down to ~4s and charts render. Huge improvement. Please do prioritize making mobile-optimized the default — we'd never have known to flip it.

From: Wei Chen
Confirmed on my throttled profile too — payload dropped to ~900KB with pagination. Wei will take Priya up on the aggregation review for the tables. Thanks all.
