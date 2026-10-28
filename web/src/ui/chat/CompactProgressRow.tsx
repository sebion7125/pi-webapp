import { localize as t } from "../locale/preference.ts";
import { IconLoadingOutline16 } from "../primitives/icons/index.tsx";
import chatCss from "./ChatView.module.css";
import css from "./CompactProgressRow.module.css";
import type { ViewCompactProgress, ViewCompactProgressLine } from "../../../../src/host/client/pi-bridge.ts";

// pi-protokoll counts the characters the model has sent; the console widget turns them into an
// approximate token count with this factor, so the browser has to use the same one.
const TOKENS_PER_CHAR = 3.5;

/** A wall time the way the status card reads it: ms below a second, one decimal to ten, minutes above a minute. */
function durationText(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

/** What the running step is doing right now: still reading, thinking, or writing the answer. */
function phaseText(line: ViewCompactProgressLine): { text: string; tokens: number | null } {
  const chars = line.chars ?? 0;
  if (line.state !== "run") return { text: "", tokens: null };
  if (chars === 0) return { text: t("Kontext lesen", "reading context"), tokens: null };
  const tokens = Math.round(chars / TOKENS_PER_CHAR);
  return { text: `${line.thinking ? t("denkt", "thinking") : t("schreibt", "writing")} ≈ ${tokens} tokens`, tokens };
}

/**
 * Transient status of a `pi-protokoll` pass that is still running: it arrives over Pi's shared
 * extension bus and is never stored in the session. It shows what the console widget shows — every
 * step with its state, its own time, and how many tokens the model has already written for it. When
 * the pass ends the status disappears and the stored card (CompactRow) takes over.
 */
export function CompactProgressRow({ progress }: { progress: ViewCompactProgress }) {
  const step = progress.steps > 0 ? Math.min(Math.max(progress.step, 1), progress.steps) : 0;
  const head = [
    progress.title || t("Compacting", "Compaction"),
    progress.steps > 0 ? t(`Schritt ${step}/${progress.steps}`, `step ${step}/${progress.steps}`) : "",
    durationText(progress.ms),
  ].filter(Boolean).join(" · ");
  return <div className={css.root} data-compact-progress data-compact-progress-run={progress.run}
    data-compact-progress-state={progress.state} data-compact-progress-step={step}
    data-compact-progress-steps={progress.steps} data-compact-progress-ms={progress.ms}
    data-compact-progress-lines={progress.lines.length}>
    <div className={css.head}>
      <span className={css.icon} aria-hidden="true"><IconLoadingOutline16 /></span>
      <span className={`${chatCss.turnStatus} ${css.headText}`} role="status" aria-live="polite" aria-atomic="true">{head}</span>
    </div>
    {progress.lines.length > 0 && <ul className={css.lines}>
      {progress.lines.map((line, index) => {
        const phase = phaseText(line);
        const time = line.state === "wait" ? "" : durationText(line.ms);
        return <li className={css.line} key={`${index}-${line.label}`} data-compact-progress-line data-compact-progress-line-state={line.state}
          data-compact-progress-line-chars={line.chars ?? undefined} data-compact-progress-line-thinking={line.thinking || undefined}>
          <span className={css.mark} aria-hidden>{line.state === "ok" ? "✓" : line.state === "fail" ? "✗" : line.state === "run" ? "▸" : "·"}</span>
          <span className={css.lineLabel}>{line.label}</span>
          {phase.text && <span className={css.phase} data-compact-progress-tokens={phase.tokens ?? undefined}>{phase.text}</span>}
          {time && <span className={css.time} aria-hidden>{time}</span>}
          {line.note && <span className={css.note}>{line.note}</span>}
        </li>;
      })}
    </ul>}
  </div>;
}
