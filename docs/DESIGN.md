# Uptime Kuma workspace design

Current references: `outputs/product-completion-20261102/design/overview.png`,
`incident.png` and `mobile.png`. The earlier references in
`outputs/premium-ui-20261101/` are retained as history.
They are illustrative mockups, never production metrics or website assets.

Direction: calm, trustworthy operational software for nontechnical owners.
White/cool pearl canvas; midnight text; restrained emerald accent; amber attention;
clear hierarchy and broad flat service rows. Keep the existing Kuma identity.

Desktop: horizontal app bar, four primary destinations, restrained profile menu.
Main content max 1440px, 24–40px gutters; title 36–48px; four unboxed summary counts;
one meaningful attention strip; group/filter/search controls; recent observations
and links to details. Disclosure of missing data is always visible.

Mobile: title 28–32px, two-by-two summary, stacked controls, compact service rows,
44px touch targets, bottom navigation with five destinations and safe area.
Avoid forcing the desktop table into horizontal scrolling.

Tokens: ink approximately #13213b, muted #5d6b81, canvas #f5f8fc,
surface white, border #dfe7ef, action #087b56, action-light #eaf7f1,
warning #995800, danger #b92c3b. Check actual contrast during implementation.
Use system UI fonts with Cyrillic, no external font/asset tracking.

The sculptural lens is the separately generated transparent asset
`public/images/monitoring-lens-v3.png`, not a crop of a mockup. Its depth, glass
and light are part of the implemented visual direction. Outline icons, the
connection trace and real observation charts use native SVG. The moving trace
communicates a connected application, not invented availability.
Use actual service names, safe hostnames and measured data. No fake 24h plot,
synthetic KPI, false delivery status or placeholder AI execution.

Transitions 150–220ms; subtle pulse only with an active connection. Respect
prefers-reduced-motion. Dark mode uses the existing theme preference.
Use text and icon together for state. Preserve keyboard focus and semantics.

Expand a service to see its measured response chart and open its incident.
The incident places real observations beside the scoped AI explanation, with
explicit evidence preview before inference. Show actual AI queue and recovery
states; an animated waiting indicator is not completion. Recovery progress marks
only retained approvals, snapshots, changes and verification outcomes. A rollback
alone never proves service health. Counter transitions replace complete actual
values; there is no simulated count-up. Loading uses a distinct state rather than
showing zero services before the first authorized list arrives.

Overview and Services share the same live service presentation in `Overview.vue`.
Keep summary, filtering, names, explicit states and observation graphics consistent
on both routes. The Services page retains ordering, tag filters and bulk operations
in a clearly labelled expandable management section. Paused checks remain readable
links with an explicit pause label; never fade their whole row to signal a pause.

The generated references contain invented domains, sample values and a misleading
24h caption: these must not be copied into production. Use “Recent observations”,
preserved samples, explicit interruptions and a distinct “No data” state instead.
