import { render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { hydrateAxeThemeColors } from '@/renderer/lib/a11yTestHelpers';
import { computeTabMappings } from '@/renderer/lib/appTabMappings';
import { computeNavSections } from '@/renderer/lib/navSections';
import {
  MESHCORE_CAPABILITIES,
  RETICULUM_CAPABILITIES,
} from '@/renderer/lib/radio/BaseRadioProvider';

const compact = vi.hoisted(() => ({ value: true }));
vi.mock('@/renderer/hooks/useMediaQuery', () => ({
  useMediaQuery: () => compact.value,
}));

import {
  MobileAppNav,
  MobileAppStatusBar,
  mobileLinkIsUp,
  mobileProtocolContexts,
  useMobileWebShell,
} from './MobileAppChrome';

const identityT = ((key: string) => key) as TFunction;
const meshcoreSections = computeNavSections(
  computeTabMappings(identityT, 'meshcore', MESHCORE_CAPABILITIES),
  MESHCORE_CAPABILITIES,
);

function renderNav(props: Partial<Parameters<typeof MobileAppNav>[0]> = {}) {
  const onSectionSelect = vi.fn();
  const onMore = vi.fn();
  const utils = render(
    <MobileAppNav
      sections={meshcoreSections}
      activeSectionId="chat"
      badgeCounts={{}}
      onSectionSelect={onSectionSelect}
      moreOpen={false}
      onMore={onMore}
      {...props}
    />,
  );
  const nav = screen.getByRole('navigation', { name: 'Application panels' });
  return { ...utils, nav, onSectionSelect, onMore };
}

function setHostKind(kind: 'web' | undefined) {
  (window.electronAPI as unknown as { hostKind?: string }).hostKind = kind;
}

describe('mobile web shell', () => {
  afterEach(() => {
    setHostKind(undefined);
    compact.value = true;
  });

  it('is used only by the web UI on a phone-sized screen', () => {
    setHostKind('web');
    expect(renderHook(() => useMobileWebShell()).result.current).toBe(true);
    compact.value = false;
    expect(renderHook(() => useMobileWebShell()).result.current).toBe(false);
    // The Electron app keeps its own compact layout in a narrow window.
    compact.value = true;
    setHostKind(undefined);
    expect(renderHook(() => useMobileWebShell()).result.current).toBe(false);
  });

  it("shows the protocol's sections in the prototype's bottom navigation, then More", async () => {
    const user = userEvent.setup();
    const { nav, onSectionSelect, onMore } = renderNav();
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Chat', 'Network', 'Map', 'Incident', 'More']);
    expect(nav).toHaveStyle({ '--mobile-nav-items': '5' });
    expect(within(nav).getByRole('button', { name: 'Chat' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(nav).getByRole('button', { name: 'Map' }));
    expect(onSectionSelect).toHaveBeenCalledWith('map');
    await user.click(within(nav).getByRole('button', { name: 'More' }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it('keeps Incident on the bar with its badge and sums hidden sections into More', () => {
    const { nav } = renderNav({ badgeCounts: { Incident: 2, Diagnostics: 3 } });
    expect(
      within(nav).getByRole('button', {
        name: 'Incident, 2 open MAYDAY or URGENT incidents',
      }),
    ).toHaveTextContent('2');
    expect(within(nav).getByRole('button', { name: /^More/ })).toHaveTextContent('3');
  });

  it('fits fewer sections into fewer columns (Reticulum)', () => {
    const sections = computeNavSections(
      computeTabMappings(identityT, 'reticulum', RETICULUM_CAPABILITIES),
      RETICULUM_CAPABILITIES,
    );
    const { nav } = renderNav({ sections });
    const buttons = within(nav).getAllByRole('button');
    expect(nav).toHaveStyle({ '--mobile-nav-items': String(buttons.length) });
  });

  it('announces the radio status from its status bar', () => {
    render(
      <MobileAppStatusBar liveStatus="Configured (TCP)">
        <button type="button">Radio: Configured (TCP)</button>
      </MobileAppStatusBar>,
    );
    const bar = screen.getByRole('contentinfo', { name: 'Connection status' });
    expect(within(bar).getByRole('status')).toHaveTextContent('Configured (TCP)');
  });

  it('describes each enabled protocol from live state for the protocol chooser', () => {
    expect(mobileLinkIsUp('configured')).toBe(true);
    expect(mobileLinkIsUp('stale')).toBe(true);
    expect(mobileLinkIsUp('connecting')).toBe(false);
    const contexts = mobileProtocolContexts(
      ['meshtastic', 'meshcore'],
      (p) =>
        p === 'meshtastic'
          ? { status: 'configured', radioLabel: ' Base station ', unreadCount: 2 }
          : { status: 'disconnected', radioLabel: null, unreadCount: 0 },
      'No radio',
    );
    expect(contexts).toEqual({
      meshtastic: { radioName: 'Base station', connected: true, unreadCount: 2 },
      meshcore: { radioName: 'No radio', connected: false, unreadCount: 0 },
      // Not enabled: never asked for, shown as no radio.
      reticulum: { radioName: 'No radio', connected: false, unreadCount: 0 },
    });
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <MobileAppNav
          sections={meshcoreSections}
          activeSectionId="network"
          badgeCounts={{ Chat: 4 }}
          onSectionSelect={vi.fn()}
          moreOpen={false}
          onMore={vi.fn()}
        />
        <MobileAppStatusBar liveStatus="Disconnected">
          <button type="button">Radio: Disconnected</button>
        </MobileAppStatusBar>
      </>,
    );
    hydrateAxeThemeColors(container);
    expect(await axe(container)).toHaveNoViolations();
  });
});
