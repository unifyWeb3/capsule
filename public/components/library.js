/**
 * The component library.
 *
 * A page imports what it needs from here, and nothing else. Every component
 * is a function from props to markup: it does not fetch, it does not know the
 * shape of a proof payload, and it does not touch the DOM except through
 * `mount`.
 *
 * The split is deliberate:
 *
 *   lib/compose.js  a payload → props            (knows the data)
 *   components/     props → markup                (knows the markup)
 *   lib/api.js      the network                  (knows the endpoints)
 *   <page>.js       a controller                  (knows the page)
 */
export { escape, html, raw, mount, showSection, loading, failed, empty } from "./dom.js";
export { StatusChip, Tag, ChainOutcome, STATUS } from "./status.js";
export { Metric, SessionBar, Meter } from "./metric.js";
export { RecordRow, RecordList } from "./record.js";
export { DataTable } from "./table.js";
export { Callout, Caveat, Panel, SurfaceCard, SurfaceGrid } from "./blocks.js";
export { TraceStep, TraceList } from "./trace.js";
export { Field, RunCard, RunList, RunComparison } from "./form.js";
export { GalleryBlock, GalleryGrid } from "./gallery.js";
export { CostPanel, SubstitutionList, VerificationPanel } from "./sections.js";
