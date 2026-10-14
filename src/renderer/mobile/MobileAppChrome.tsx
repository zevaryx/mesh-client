import './mobile.css';
import './mobileApp.css';

import { Ellipsis } from 'lucide-react-motion';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useMediaQuery } from '@/renderer/hooks/useMediaQuery';
import { SHELL_COMPACT_QUERY, splitBottomNavSections } from '@/renderer/lib/bottomNav';
import { isWebHost } from '@/renderer/lib/hostKind';
import { NavSectionIcon } from '@/renderer/lib/icons/tabIcons';
import {
  formatBadgeCount,
  NAV_BADGE_FILL_CLASS,
  type NavBadge,
  navBadgeAriaLabel,
  type NavBadgeCounts,
  sectionBadge,
  sumNavBadges,
} from '@/renderer/lib/navBadges';
import {
  NAV_SECTION_LABEL_KEYS,
  type NavSection,
  type NavSectionId,
} from '@/renderer/lib/navSections';
import type { ConnectionStatus } from '@/renderer/lib/types';
import { type MeshProtocol, REGISTERED_MESH_PROTOCOLS } from '@/shared/meshProtocol';

/**
 * The web UI on a phone-sized screen (below 768px, the shell's compact breakpoint) uses the mobile
 * prototype's shell (`MobilePrototype.tsx`, `mobile.css`) around the app's live panels. The
 * Electron app keeps its own compact layout in a narrow window.
 */
export function useMobileWebShell(): boolean {
  const compact = useMediaQuery(SHELL_COMPACT_QUERY);
  return compact && isWebHost();
}

export interface MobileProtocolContext {
  radioName: string;
  connected: boolean;
  unreadCount: number;
}

/** The radio link counts as up for these states (a stale link is still the radio in use). */
export function mobileLinkIsUp(status: ConnectionStatus): boolean {
  return status === 'connected' || status === 'configured' || status === 'stale';
}

/**
 * The protocol chooser's rows from live state: the radio's node label while it has one, else
 * `noRadioLabel`; link state; unread count.
 */
export function mobileProtocolContexts(
  protocols: readonly MeshProtocol[],
  state: (protocol: MeshProtocol) => {
    status: ConnectionStatus;
    radioLabel: string | null;
    unreadCount: number;
  },
  noRadioLabel: string,
): Record<MeshProtocol, MobileProtocolContext> {
  const contexts = {} as Record<MeshProtocol, MobileProtocolContext>;
  for (const protocol of REGISTERED_MESH_PROTOCOLS) {
    const s = protocols.includes(protocol)
      ? state(protocol)
      : { status: 'disconnected' as const, radioLabel: null, unreadCount: 0 };
    contexts[protocol] = {
      radioName: s.radioLabel?.trim() || noRadioLabel,
      connected: mobileLinkIsUp(s.status),
      unreadCount: s.unreadCount,
    };
  }
  return contexts;
}

/** Root classes for `data-app-shell` in the mobile shell (`mobile.css` + `mobileApp.css`). */
export const MOBILE_APP_SHELL_CLASS = 'mobile-shell mobile-app';

export interface MobileAppNavProps {
  sections: readonly NavSection[];
  activeSectionId: NavSectionId | undefined;
  badgeCounts: NavBadgeCounts;
  onSectionSelect: (id: NavSectionId) => void;
  /** More opens the app launcher (every panel, contacts, channels, settings). */
  moreOpen: boolean;
  onMore: () => void;
}

/**
 * The prototype's bottom navigation with the app's sections: Chat, Network, Map and Incident when
 * the protocol has them (Incident is never moved under More, EMCOMM S9), then More.
 */
export function MobileAppNav({
  sections,
  activeSectionId,
  badgeCounts,
  onSectionSelect,
  moreOpen,
  onMore,
}: MobileAppNavProps) {
  const { t } = useTranslation();
  const { primary, overflow } = splitBottomNavSections(sections);
  const moreActive = overflow.some((section) => section.id === activeSectionId);
  const moreBadge = sumNavBadges(overflow.map((section) => sectionBadge(section, badgeCounts)));
  return (
    <nav
      className="mobile-nav"
      aria-label={t('aria.applicationPanels')}
      style={{ '--mobile-nav-items': primary.length + 1 } as CSSProperties}
    >
      <div className="mobile-nav-primary">
        {primary.map((section) => {
          const label = t(NAV_SECTION_LABEL_KEYS[section.id]);
          const badge = sectionBadge(section, badgeCounts);
          const active = section.id === activeSectionId;
          return (
            <button
              key={section.id}
              type="button"
              data-nav-section={section.id}
              aria-label={navBadgeAriaLabel(t, label, badge)}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                onSectionSelect(section.id);
              }}
            >
              <NavSectionIcon id={section.id} />
              <span>{label}</span>
              <MobileNavBadge badge={badge} />
            </button>
          );
        })}
      </div>
      <div className="mobile-nav-footer">
        <button
          type="button"
          data-nav-section="more"
          aria-label={navBadgeAriaLabel(t, t('shell.more'), moreBadge)}
          aria-current={moreActive ? 'page' : undefined}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={onMore}
        >
          <Ellipsis aria-hidden="true" size={20} />
          <span>{t('shell.more')}</span>
          <MobileNavBadge badge={moreBadge} />
        </button>
      </div>
    </nav>
  );
}

function MobileNavBadge({ badge }: { badge: NavBadge | null }) {
  if (!badge) return null;
  return (
    <span
      aria-hidden="true"
      className={`mobile-app-nav-badge text-label font-mono leading-none font-medium text-white ${NAV_BADGE_FILL_CLASS[badge.tone]}`}
    >
      {formatBadgeCount(badge.count)}
    </span>
  );
}

export interface MobileAppStatusBarProps {
  /** Announced to screen readers when it changes (the radio status), as in the desktop bar. */
  liveStatus: string;
  /** The app's live status buttons (radio, MQTT, TAK, queue). */
  children: ReactNode;
}

/** The prototype's status bar holding the app's live status buttons. */
export function MobileAppStatusBar({ liveStatus, children }: MobileAppStatusBarProps) {
  const { t } = useTranslation();
  return (
    <footer className="mobile-status-bar mobile-app-status" aria-label={t('mobileApp.statusBar')}>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveStatus}
      </span>
      {children}
    </footer>
  );
}
