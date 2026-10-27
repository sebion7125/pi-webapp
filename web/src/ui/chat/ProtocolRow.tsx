import { useState } from "react";
import type { ViewProtocol } from "../../../../src/host/client/pi-bridge.ts";
import { DisclosureRow } from "../primitives/DisclosureRow.tsx";
import { IconPlanOutline14 } from "../primitives/icons/index.tsx";
import css from "./ProtocolRow.module.css";
import { localize as t } from "../locale/preference.ts";

// Section keys come from the protocol entry itself, so an unknown key still
// renders under its own name and a missing key simply leaves the section out.
const SECTION_LABELS: Record<string, readonly [string, string]> = {
  result: ["结果", "Result"],
  decision: ["决定", "Decision"],
  files: ["文件", "Files"],
  open: ["待办", "Open"],
  rule: ["规则", "Rule"],
  revoke: ["作废规则", "Revoked rule"],
  index: ["概要", "Index"],
  tags: ["标记", "Tags"],
  other: ["备注", "Note"],
};
const SOURCE_LABELS: Record<string, readonly [string, string]> = {
  inline: ["回答内联", "inline"],
  followup: ["补问后写入", "asked for"],
  backfill: ["事后补写", "written afterwards"],
  missing: ["缺失", "missing"],
};

function sectionLabel(key: string): string {
  const labels = SECTION_LABELS[key];
  return labels ? t(labels[0], labels[1]) : key;
}

function sourceLabel(source: string | null): string | null {
  if (!source) return null;
  const labels = SOURCE_LABELS[source];
  return labels ? t(labels[0], labels[1]) : source;
}

/** Collapsible card for one persistent session protocol entry. */
export function ProtocolRow({ protocol }: { protocol: ViewProtocol }) {
  const [expanded, setExpanded] = useState(false);
  const first = (key: string) => protocol.sections.find(section => section.key === key)?.items[0];
  const summary = first("result") ?? first("decision") ?? first("index") ?? first("open")
    ?? (protocol.sections[0]?.items[0] ?? t("无协议内容", "No protocol recorded"));
  const origin = sourceLabel(protocol.source);
  const title = protocol.turn === null ? t("会话协议", "Session protocol") : t(`会话协议 第 ${protocol.turn} 轮`, `Session protocol turn ${protocol.turn}`);
  return <div className={css.root} data-protocol-card data-expanded={expanded || undefined}
    data-protocol-turn={protocol.turn ?? undefined} data-protocol-source={protocol.source ?? undefined}>
    <DisclosureRow icon={<IconPlanOutline14 size={14} />} title={title} open={expanded} onToggle={() => setExpanded(value => !value)}
      rowClassName={css.row} leadingClassName={css.leading} titleClassName={css.title} chevronClassName={css.chevron}
      collapsedContent={<><span className={css.separator} aria-hidden /><span className={css.summary}><span className={css.summaryText}>{summary}</span></span>{origin && <span className={css.summarySuffix}>{origin}</span>}</>}>
      <div className={css.card}>
        {protocol.sections.length === 0
          ? <div className={css.empty}>{t("该轮没有记录协议内容。", "This turn has no protocol content.")}</div>
          : protocol.sections.map(section => <div className={css.section} key={section.key} data-protocol-section={section.key}>
            <span className={css.sectionLabel} title={section.key}>{sectionLabel(section.key)}</span>
            <ul className={css.sectionList}>
              {section.items.map((item, index) => <li className={css.sectionItem} key={index}>{item}</li>)}
            </ul>
          </div>)}
      </div>
    </DisclosureRow>
  </div>;
}
