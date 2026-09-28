import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

const STORAGE_PREFIX = 'mailflow_first_use_tour_completed:';

function storageKey(userId) {
  return `${STORAGE_PREFIX}${userId || 'anonymous'}`;
}

export function hasCompletedFirstUseTour(userId) {
  try {
    return localStorage.getItem(storageKey(userId)) === '1';
  } catch {
    return false;
  }
}

function markCompleted(userId) {
  try {
    localStorage.setItem(storageKey(userId), '1');
  } catch {
    // A blocked storage area should not prevent the tour from running.
  }
}

export function createFirstUseTour({ t, userId, isMobile = false, onDestroyed } = {}) {
  const steps = [
    {
      element: '[data-tour="compose"]',
      popover: {
        title: t('tour.compose.title'),
        description: t('tour.compose.description'),
        side: 'right',
      },
    },
    {
      element: '[data-tour="mailbox-sidebar"]',
      popover: {
        title: t('tour.mailboxes.title'),
        description: t('tour.mailboxes.description'),
        side: 'right',
      },
    },
    !isMobile && {
      element: '[data-tour="search"]',
      popover: {
        title: t('tour.search.title'),
        description: t('tour.search.description'),
        side: 'bottom',
      },
    },
    {
      element: '[data-tour="user-menu"]',
      popover: {
        title: t('tour.userMenu.title'),
        description: t('tour.userMenu.description'),
        side: 'right',
      },
    },
  ].filter(Boolean);

  const instance = driver({
    steps,
    animate: true,
    smoothScroll: true,
    allowClose: true,
    allowKeyboardControl: true,
    showProgress: true,
    skipMissingElement: true,
    overlayOpacity: 0.62,
    stagePadding: 6,
    stageRadius: 9,
    popoverClass: 'mailflow-tour',
    nextBtnText: t('tour.next'),
    prevBtnText: t('tour.previous'),
    doneBtnText: t('tour.done'),
    progressText: t('tour.progress'),
    onPopoverRender: (popover) => {
      popover.closeButton.textContent = t('tour.skip');
      popover.closeButton.setAttribute('aria-label', t('tour.skip'));
    },
    onDestroyed: () => {
      markCompleted(userId);
      onDestroyed?.();
    },
  });

  return instance;
}
