import type { BusinessHoursConfig } from '@/types/database';

export interface BusinessHoursStatus {
  isOpen: boolean;
  scheduleSummary: string;
  nextOpenText?: string;
}

const DAYS: Array<keyof BusinessHoursConfig['schedule']> = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const DAY_LABELS: Record<keyof BusinessHoursConfig['schedule'], string> = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
};

/**
 * Summarizes the workspace's business hours in a concise format
 * e.g., "Mon-Fri 09:00 - 17:00 (UTC)"
 */
export function formatBusinessHoursSummary(
  businessHours?: BusinessHoursConfig | null
): string {
  if (!businessHours || !businessHours.enabled || !businessHours.schedule) {
    return '24/7';
  }

  const activeDays = DAYS.filter((d) => businessHours.schedule[d]?.enabled);
  if (activeDays.length === 0) {
    return 'by appointment';
  }

  const firstDay = businessHours.schedule[activeDays[0]];
  const allSameHours = activeDays.every(
    (d) =>
      businessHours.schedule[d]?.start === firstDay.start &&
      businessHours.schedule[d]?.end === firstDay.end
  );

  const tz = businessHours.timezone || 'UTC';

  if (allSameHours) {
    const isMonFri =
      activeDays.length === 5 &&
      !activeDays.includes('saturday') &&
      !activeDays.includes('sunday');
    const isAllWeek = activeDays.length === 7;

    const daysText = isMonFri
      ? 'Mon - Fri'
      : isAllWeek
      ? 'Daily'
      : activeDays.map((d) => DAY_LABELS[d]).join(', ');

    return `${daysText} ${firstDay.start} - ${firstDay.end} (${tz})`;
  }

  return `${activeDays.map((d) => `${DAY_LABELS[d]} ${businessHours.schedule[d].start}-${businessHours.schedule[d].end}`).join(', ')} (${tz})`;
}

/**
 * Checks whether the workspace is currently open based on business hours.
 */
export function checkWorkspaceBusinessHours(
  businessHours?: BusinessHoursConfig | null,
  now: Date = new Date()
): BusinessHoursStatus {
  if (!businessHours || !businessHours.enabled || !businessHours.schedule) {
    return {
      isOpen: true,
      scheduleSummary: '24/7',
    };
  }

  const tz = businessHours.timezone || 'UTC';
  const summary = formatBusinessHoursSummary(businessHours);

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const weekdayPart = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase();
    const hourPart = parts.find((p) => p.type === 'hour')?.value || '00';
    const minutePart = parts.find((p) => p.type === 'minute')?.value || '00';

    const currentDay = weekdayPart as keyof BusinessHoursConfig['schedule'];
    const currentTime = `${hourPart}:${minutePart}`;

    const dayConfig = businessHours.schedule[currentDay];
    if (dayConfig && dayConfig.enabled) {
      if (currentTime >= dayConfig.start && currentTime <= dayConfig.end) {
        return {
          isOpen: true,
          scheduleSummary: summary,
        };
      }
    }

    return {
      isOpen: false,
      scheduleSummary: summary,
      nextOpenText: summary,
    };
  } catch (err) {
    console.warn('[business-hours] Failed to compute timezone/hours, defaulting to open:', err);
    return {
      isOpen: true,
      scheduleSummary: summary,
    };
  }
}
