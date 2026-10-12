/**
 * Meshtastic text packet decoding, shared by the renderer (`MeshtasticProtocol.subscribe`) and the
 * main-process background ingest (`src/main/meshtastic-backend/`).
 *
 * Node-safe on purpose: no stores, DOM, or `window.electronAPI`, so the main bundle can import it.
 */
import { formatMeshtasticNodeId } from '../../../shared/nodeNameUtils';
import { meshtasticPacketRxTimeMs } from '../meshtasticLastHeard';
import { meshtasticComputedRfHopsAway } from '../meshtasticRfHops';
import type { DomainEvent } from './Protocol';

export const MESHTASTIC_MAX_TEXT_MESSAGE_CHARS = 1024;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Node numbers are unsigned 32-bit; reject NaN / negative / out-of-range values. */
export function normalizedNodeNum(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  const num = Math.trunc(value);
  if (num < 0 || num > 0xffffffff) return undefined;
  return num >>> 0;
}

/** Chat `sender_name`: short name, else long name cut to 7 chars, else `!xxxxxxxx`. */
export function meshtasticSenderDisplayName(
  from: number,
  node: { shortName?: string; longName?: string } | undefined,
): string {
  const shortName = node?.shortName?.trim();
  if (shortName) return shortName;
  const longName = node?.longName?.trim();
  if (longName) return longName.length > 7 ? longName.slice(0, 7) : longName;
  return formatMeshtasticNodeId(from);
}

/** TEXT_MESSAGE_APP / ALERT_APP mesh packet → `text_message` event (empty when undecodable). */
export function decodeMeshtasticTextPacket(raw: unknown): DomainEvent[] {
  const p = raw as {
    payloadVariant: {
      case: string;
      value: { payload: Uint8Array; replyId?: number; reply_id?: number; emoji?: number };
    };
    from: number;
    to: number;
    id: number;
    channel?: number;
    rxTime?: Date | number;
    rxSnr?: number;
    rxRssi?: number;
    hopStart?: number;
    hopLimit?: number;
    viaMqtt?: boolean;
  };
  if (p.payloadVariant.case !== 'decoded') return [];
  const data = p.payloadVariant.value;
  if (!(data.payload instanceof Uint8Array)) return [];
  const from = normalizedNodeNum(p.from);
  const to = normalizedNodeNum(p.to);
  if (from === undefined || to === undefined) return [];
  const hopCount = meshtasticComputedRfHopsAway(p);
  const rawReplyId = data.replyId ?? data.reply_id;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data.payload);
  } catch {
    // catch-no-log-ok malformed inbound text is dropped before reaching UI or persistence
    return [];
  }
  return [
    {
      type: 'text_message',
      payload: {
        id: String(normalizedNodeNum(p.id) ?? 0),
        from,
        to,
        payload:
          text.length > MESHTASTIC_MAX_TEXT_MESSAGE_CHARS
            ? text.slice(0, MESHTASTIC_MAX_TEXT_MESSAGE_CHARS)
            : text,
        channelIndex: isFiniteNumber(p.channel) ? Math.trunc(p.channel) : 0,
        timestamp: meshtasticPacketRxTimeMs(p.rxTime) || Date.now(),
        rxSnr: p.rxSnr,
        rxRssi: p.rxRssi,
        ...(hopCount != null ? { hopCount } : {}),
        replyTo: rawReplyId ? String(rawReplyId) : undefined,
        tapback: data.emoji != null ? data.emoji !== 0 : undefined,
      },
    },
  ];
}
