import { useState } from "react";
import type { ViewCompact } from "../../../../src/host/client/pi-bridge.ts";
import { DisclosureRow } from "../primitives/DisclosureRow.tsx";
import { IconRefreshOutline14 } from "../primitives/icons/index.tsx";
import css from "./CompactRow.module.css";
import { localize as t } from "../locale/preference.ts";

// The keys are the fields of the stored status entry, so a field a newer
// extension version adds shows up under its own name instead of vanishing.
const COUNT_LABELS: readonly (readonly [keyof ViewCompact, string, string])[] = [
  ["condensedTurns", "verdichtete Runden", "turns condensed"],
  ["detailTurns", "im Detail", "in detail"],
  ["keptTurns", "voll behalten", "kept in full"],
  ["missingTurns", "ohne Protokoll", "without protocol"],
  ["backfilled", "später geschrieben", "written afterwards"],
  ["newlyFolded", "neu gefaltet", "newly folded"],
  ["pending", "noch nicht gefaltet", "not folded yet"],
];
const OUTCOME_LABELS: Record<string, readonly [string, string]> = {
  protocol: ["Protokoll-Zusammenfassung", "protocol summary"],
  no_room: ["Platz nicht frei genug – Pi hat zusammengefasst", "no room – Pi summarized"],
  failed: ["fehlgeschlagen – Pi hat zusammengefasst", "failed – Pi summarized"],
};

/** A wall time the way one reads it: ms below a second, one decimal to ten, minutes above a minute. */
function durationText(ms: number | null): string {
  if (ms === null) return t("unbekannt", "unknown");
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

function outcomeLabel(outcome: string | null): string | null {
  if (!outcome) return null;
  const labels = OUTCOME_LABELS[outcome];
  return labels ? t(labels[0], labels[1]) : outcome;
}

/** Collapsible card for one stored compaction status entry: what it did and how long it took. */
export function CompactRow({ compact }: { compact: ViewCompact }) {
  const [expanded, setExpanded] = useState(false);
  const counts = COUNT_LABELS
    .map(([key, zh, en]) => [compact[key], zh, en] as const)
    .filter((entry): entry is readonly [number, string, string] => typeof entry[0] === "number");
  // A collapsed line reads as what happened, so the zeros stay in the card body only.
  const headline = counts.filter(([value]) => value > 0);
  const summary = headline.length > 0
    ? headline.map(([value, zh, en]) => `${value} ${t(zh, en)}`).join(", ")
    : t("Compacting abgeschlossen", "Compaction finished");
  const outcome = outcomeLabel(compact.outcome);
  return <div className={css.root} data-compact-card data-expanded={expanded || undefined}
    data-compact-outcome={compact.outcome ?? undefined} data-compact-duration-ms={compact.durationMs ?? undefined}>
    <DisclosureRow icon={<IconRefreshOutline14 size={14} />} title={t("Compacting", "Compaction")} open={expanded}
      onToggle={() => setExpanded(value => !value)}
      rowClassName={css.row} leadingClassName={css.leading} titleClassName={css.title} chevronClassName={css.chevron}
      collapsedContent={<><span className={css.separator} aria-hidden /><span className={css.duration}>{durationText(compact.durationMs)}</span><span className={css.summary}><span className={css.summaryText}>{summary}</span></span>{outcome && <span className={css.summarySuffix}>{outcome}</span>}</>}>
      <div className={css.card}>
        <div className={css.section} data-compact-section="duration">
          <span className={css.sectionLabel}>{t("Dauer", "Duration")}</span>
          <div className={css.sectionValue}>
            <span className={css.durationValue}>{durationText(compact.durationMs)}</span>
            {compact.startedAt && <span className={css.startedAt}>{compact.startedAt}</span>}
          </div>
        </div>
        {counts.length > 0 && <div className={css.section} data-compact-section="counts">
          <span className={css.sectionLabel}>{t("Ergebnis", "Result")}</span>
          <ul className={css.sectionList}>
            {counts.map(([value, zh, en]) => <li className={css.sectionItem} key={String(zh)}>{value} {t(zh, en)}</li>)}
          </ul>
        </div>}
        {compact.steps.length > 0 && <div className={css.section} data-compact-section="steps">
          <span className={css.sectionLabel}>{t("Schritte", "Steps")}</span>
          <ul className={css.sectionList}>
            {compact.steps.map((step, index) => <li className={css.sectionItem} key={index} data-compact-step-state={step.state}>
              <span className={css.stepMark} aria-hidden>{step.state === "ok" ? "✓" : step.state === "fail" ? "✗" : "·"}</span>
              <span className={css.stepLabel}>{step.label}</span>
              {step.note && <span className={css.stepNote}>{step.note}</span>}
              <span className={css.stepTime}>{step.ms === null ? t("nicht gelaufen", "never ran") : durationText(step.ms)}</span>
            </li>)}
          </ul>
        </div>}
        {compact.notes.length > 0 && <div className={css.section} data-compact-section="notes">
          <span className={css.sectionLabel}>{t("Meldungen", "Notes")}</span>
          <ul className={css.sectionList}>
            {compact.notes.map((note, index) => <li className={css.sectionItem} key={index}>{note}</li>)}
          </ul>
        </div>}
        {compact.error && <div className={css.section} data-compact-section="error">
          <span className={css.sectionLabel}>{t("Fehler", "Error")}</span>
          <ul className={css.sectionList}><li className={css.sectionItem}>{compact.error}</li></ul>
        </div>}
      </div>
    </DisclosureRow>
  </div>;
}
