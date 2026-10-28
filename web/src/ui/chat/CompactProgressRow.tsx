import { localize as t } from "../locale/preference.ts";
import { IconLoadingOutline16 } from "../primitives/icons/index.tsx";
import chatCss from "./ChatView.module.css";
import css from "./CompactProgressRow.module.css";
import type { ViewCompactProgress } from "../../../../src/host/client/pi-bridge.ts";

/**
 * Transient line of a `pi-protokoll` pass that is still running: it arrives over Pi's shared
 * extension bus and is never stored in the session. When the pass ends the line disappears and the
 * stored status card (CompactRow) takes over with the time of every step.
 */
export function CompactProgressRow({ progress }: { progress: ViewCompactProgress }) {
  const seconds = Math.max(0, Math.round(progress.ms / 1000));
  const step = progress.steps > 0 ? Math.min(Math.max(progress.step, 1), progress.steps) : 0;
  return <div className={css.root} data-compact-progress data-compact-progress-run={progress.run}
    data-compact-progress-state={progress.state} data-compact-progress-step={step}
    data-compact-progress-steps={progress.steps} data-compact-progress-ms={progress.ms}>
    <span className={css.icon} aria-hidden="true"><IconLoadingOutline16 /></span>
    <span className={`${chatCss.turnStatus} ${css.copy}`}>
      <span role="status" aria-live="polite" aria-atomic="true">{progress.title || t("Compacting", "Compaction")}</span>
      {progress.steps > 0 && <span data-compact-progress-step-text="">{t(`Schritt ${step}/${progress.steps}`, `step ${step}/${progress.steps}`)}</span>}
      {progress.label && <span data-compact-progress-label="">{progress.label}</span>}
      {/* per-second ticks stay out of the live region, like the working line does */}
      <span data-compact-elapsed={seconds} aria-hidden="true">{t(`· ${seconds} s`, `· ${seconds} s`)}</span>
    </span>
  </div>;
}
