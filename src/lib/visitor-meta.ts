/**
 * Turns the raw strings we store on a visitor (user agent, "City, Country")
 * into the pieces the visitor panel shows: a browser and its version, an OS,
 * a device class, a country flag, and the visitor's own local time.
 *
 * Everything here degrades to null rather than guessing — an agent acting on a
 * wrong city or a wrong local time is worse off than one shown nothing.
 */

export type BrowserId =
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'safari'
  | 'opera'
  | 'samsung'
  | 'unknown';

export type OsId =
  | 'windows'
  | 'macos'
  | 'ios'
  | 'android'
  | 'linux'
  | 'chromeos'
  | 'unknown';

export type DeviceId = 'desktop' | 'mobile' | 'tablet';

export interface UserAgentInfo {
  browser: BrowserId;
  browserName: string;
  browserVersion: string | null;
  os: OsId;
  osName: string;
  osVersion: string | null;
  device: DeviceId;
}

const UNKNOWN_UA: UserAgentInfo = {
  browser: 'unknown',
  browserName: 'Unknown browser',
  browserVersion: null,
  os: 'unknown',
  osName: 'Unknown OS',
  osVersion: null,
  device: 'desktop',
};

function version(ua: string, pattern: RegExp): string | null {
  const m = ua.match(pattern);
  return m?.[1] ? m[1].split('.')[0] : null;
}

export function parseUserAgentDetailed(ua: string | null | undefined): UserAgentInfo {
  if (!ua) return UNKNOWN_UA;

  // Order matters: Edge and Opera both claim to be Chrome, and Chrome claims
  // to be Safari, so the most specific token has to win.
  let browser: BrowserId = 'unknown';
  let browserName = 'Unknown browser';
  let browserVersion: string | null = null;

  if (/Edg[A-Z]?\//.test(ua)) {
    browser = 'edge';
    browserName = 'Edge';
    browserVersion = version(ua, /Edg[A-Z]?\/([\d.]+)/);
  } else if (/OPR\/|Opera/.test(ua)) {
    browser = 'opera';
    browserName = 'Opera';
    browserVersion = version(ua, /(?:OPR|Opera)\/([\d.]+)/);
  } else if (/SamsungBrowser\//.test(ua)) {
    browser = 'samsung';
    browserName = 'Samsung Internet';
    browserVersion = version(ua, /SamsungBrowser\/([\d.]+)/);
  } else if (/Firefox\/|FxiOS\//.test(ua)) {
    browser = 'firefox';
    browserName = 'Firefox';
    browserVersion = version(ua, /(?:Firefox|FxiOS)\/([\d.]+)/);
  } else if (/Chrome\/|CriOS\//.test(ua)) {
    browser = 'chrome';
    browserName = 'Chrome';
    browserVersion = version(ua, /(?:Chrome|CriOS)\/([\d.]+)/);
  } else if (/Safari\//.test(ua)) {
    browser = 'safari';
    browserName = 'Safari';
    browserVersion = version(ua, /Version\/([\d.]+)/);
  }

  let os: OsId = 'unknown';
  let osName = 'Unknown OS';
  let osVersion: string | null = null;

  if (/Windows NT/.test(ua)) {
    os = 'windows';
    osName = 'Windows';
    // Windows 11 is indistinguishable from 10 in the UA string, so report the
    // family rather than inventing a version.
    osVersion = /Windows NT 10/.test(ua) ? '10/11' : null;
  } else if (/Android/.test(ua)) {
    os = 'android';
    osName = 'Android';
    osVersion = version(ua, /Android ([\d.]+)/);
  } else if (/iPhone|iPad|iPod/.test(ua)) {
    os = 'ios';
    osName = /iPad/.test(ua) ? 'iPadOS' : 'iOS';
    osVersion = version(ua, /OS ([\d_]+)/)?.replace(/_/g, '.') ?? null;
  } else if (/Mac OS X|Macintosh/.test(ua)) {
    os = 'macos';
    osName = 'macOS';
    osVersion = version(ua, /Mac OS X ([\d_]+)/)?.replace(/_/g, '.') ?? null;
  } else if (/CrOS/.test(ua)) {
    os = 'chromeos';
    osName = 'ChromeOS';
  } else if (/Linux/.test(ua)) {
    os = 'linux';
    osName = 'Linux';
  }

  const device: DeviceId = /iPad|Tablet/.test(ua)
    ? 'tablet'
    : /Mobi|Android|iPhone|iPod/.test(ua)
    ? 'mobile'
    : 'desktop';

  return { browser, browserName, browserVersion, os, osName, osVersion, device };
}

/* ------------------------------------------------------------------ country */

/**
 * Country names we can turn into a flag. Deliberately a lookup rather than a
 * clever heuristic: a wrong flag next to a customer's name looks careless.
 */
const COUNTRY_CODES: Record<string, string> = {
  afghanistan: 'AF', albania: 'AL', algeria: 'DZ', andorra: 'AD', angola: 'AO',
  argentina: 'AR', armenia: 'AM', australia: 'AU', austria: 'AT', azerbaijan: 'AZ',
  bahamas: 'BS', bahrain: 'BH', bangladesh: 'BD', belarus: 'BY', belgium: 'BE',
  belize: 'BZ', bolivia: 'BO', bosnia: 'BA', brazil: 'BR', bulgaria: 'BG',
  cambodia: 'KH', cameroon: 'CM', canada: 'CA', chile: 'CL', china: 'CN',
  colombia: 'CO', costa_rica: 'CR', 'costa rica': 'CR', croatia: 'HR', cuba: 'CU',
  cyprus: 'CY', czechia: 'CZ', 'czech republic': 'CZ', denmark: 'DK', ecuador: 'EC',
  egypt: 'EG', 'el salvador': 'SV', estonia: 'EE', ethiopia: 'ET', finland: 'FI',
  france: 'FR', georgia: 'GE', germany: 'DE', ghana: 'GH', greece: 'GR',
  guatemala: 'GT', 'hong kong': 'HK', hungary: 'HU', iceland: 'IS', india: 'IN',
  indonesia: 'ID', iran: 'IR', iraq: 'IQ', ireland: 'IE', israel: 'IL',
  italy: 'IT', jamaica: 'JM', japan: 'JP', jordan: 'JO', kazakhstan: 'KZ',
  kenya: 'KE', kuwait: 'KW', latvia: 'LV', lebanon: 'LB', libya: 'LY',
  lithuania: 'LT', luxembourg: 'LU', malaysia: 'MY', maldives: 'MV', malta: 'MT',
  mexico: 'MX', moldova: 'MD', monaco: 'MC', mongolia: 'MN', montenegro: 'ME',
  morocco: 'MA', nepal: 'NP', netherlands: 'NL', 'new zealand': 'NZ', nigeria: 'NG',
  'north macedonia': 'MK', norway: 'NO', oman: 'OM', pakistan: 'PK', palestine: 'PS',
  panama: 'PA', paraguay: 'PY', peru: 'PE', philippines: 'PH', poland: 'PL',
  portugal: 'PT', qatar: 'QA', romania: 'RO', russia: 'RU', 'saudi arabia': 'SA',
  senegal: 'SN', serbia: 'RS', singapore: 'SG', slovakia: 'SK', slovenia: 'SI',
  'south africa': 'ZA', 'south korea': 'KR', korea: 'KR', spain: 'ES',
  'sri lanka': 'LK', sudan: 'SD', sweden: 'SE', switzerland: 'CH', syria: 'SY',
  taiwan: 'TW', tajikistan: 'TJ', tanzania: 'TZ', thailand: 'TH', tunisia: 'TN',
  turkey: 'TR', 'türkiye': 'TR', turkmenistan: 'TM', uganda: 'UG', ukraine: 'UA',
  'united arab emirates': 'AE', uae: 'AE', 'united kingdom': 'GB', uk: 'GB',
  england: 'GB', 'united states': 'US', 'united states of america': 'US', usa: 'US',
  us: 'US', uruguay: 'UY', uzbekistan: 'UZ', venezuela: 'VE', vietnam: 'VN',
  yemen: 'YE', zambia: 'ZM', zimbabwe: 'ZW',
};

/** IANA Timezone mapping for accurate fallback when IP geo is blocked */
const TIMEZONE_TO_COUNTRY: Record<string, { city: string; country: string; code: string }> = {
  'asia/karachi': { city: 'Karachi', country: 'Pakistan', code: 'PK' },
  'asia/kolkata': { city: 'New Delhi', country: 'India', code: 'IN' },
  'asia/calcutta': { city: 'Kolkata', country: 'India', code: 'IN' },
  'asia/dhaka': { city: 'Dhaka', country: 'Bangladesh', code: 'BD' },
  'asia/dubai': { city: 'Dubai', country: 'United Arab Emirates', code: 'AE' },
  'asia/muscat': { city: 'Muscat', country: 'Oman', code: 'OM' },
  'asia/riyadh': { city: 'Riyadh', country: 'Saudi Arabia', code: 'SA' },
  'asia/kuwait': { city: 'Kuwait City', country: 'Kuwait', code: 'KW' },
  'asia/qatar': { city: 'Doha', country: 'Qatar', code: 'QA' },
  'asia/bahrain': { city: 'Manama', country: 'Bahrain', code: 'BH' },
  'asia/kabul': { city: 'Kabul', country: 'Afghanistan', code: 'AF' },
  'asia/tashkent': { city: 'Tashkent', country: 'Uzbekistan', code: 'UZ' },
  'asia/bangkok': { city: 'Bangkok', country: 'Thailand', code: 'TH' },
  'asia/singapore': { city: 'Singapore', country: 'Singapore', code: 'SG' },
  'asia/kuala_lumpur': { city: 'Kuala Lumpur', country: 'Malaysia', code: 'MY' },
  'asia/jakarta': { city: 'Jakarta', country: 'Indonesia', code: 'ID' },
  'asia/manila': { city: 'Manila', country: 'Philippines', code: 'PH' },
  'asia/tokyo': { city: 'Tokyo', country: 'Japan', code: 'JP' },
  'asia/seoul': { city: 'Seoul', country: 'South Korea', code: 'KR' },
  'asia/shanghai': { city: 'Shanghai', country: 'China', code: 'CN' },
  'asia/hong_kong': { city: 'Hong Kong', country: 'Hong Kong', code: 'HK' },
  'asia/colombo': { city: 'Colombo', country: 'Sri Lanka', code: 'LK' },
  'asia/kathmandu': { city: 'Kathmandu', country: 'Nepal', code: 'NP' },
  'asia/baku': { city: 'Baku', country: 'Azerbaijan', code: 'AZ' },
  'asia/tbilisi': { city: 'Tbilisi', country: 'Georgia', code: 'GE' },
  'asia/yerevan': { city: 'Yerevan', country: 'Armenia', code: 'AM' },
  'europe/london': { city: 'London', country: 'United Kingdom', code: 'GB' },
  'europe/dublin': { city: 'Dublin', country: 'Ireland', code: 'IE' },
  'europe/paris': { city: 'Paris', country: 'France', code: 'FR' },
  'europe/berlin': { city: 'Berlin', country: 'Germany', code: 'DE' },
  'europe/rome': { city: 'Rome', country: 'Italy', code: 'IT' },
  'europe/madrid': { city: 'Madrid', country: 'Spain', code: 'ES' },
  'europe/amsterdam': { city: 'Amsterdam', country: 'Netherlands', code: 'NL' },
  'europe/brussels': { city: 'Brussels', country: 'Belgium', code: 'BE' },
  'europe/vienna': { city: 'Vienna', country: 'Austria', code: 'AT' },
  'europe/zurich': { city: 'Zurich', country: 'Switzerland', code: 'CH' },
  'europe/stockholm': { city: 'Stockholm', country: 'Sweden', code: 'SE' },
  'europe/oslo': { city: 'Oslo', country: 'Norway', code: 'NO' },
  'europe/helsinki': { city: 'Helsinki', country: 'Finland', code: 'FI' },
  'europe/copenhagen': { city: 'Copenhagen', country: 'Denmark', code: 'DK' },
  'europe/warsaw': { city: 'Warsaw', country: 'Poland', code: 'PL' },
  'europe/prague': { city: 'Prague', country: 'Czechia', code: 'CZ' },
  'europe/budapest': { city: 'Budapest', country: 'Hungary', code: 'HU' },
  'europe/bucharest': { city: 'Bucharest', country: 'Romania', code: 'RO' },
  'europe/athens': { city: 'Athens', country: 'Greece', code: 'GR' },
  'europe/istanbul': { city: 'Istanbul', country: 'Turkey', code: 'TR' },
  'europe/kyiv': { city: 'Kyiv', country: 'Ukraine', code: 'UA' },
  'europe/moscow': { city: 'Moscow', country: 'Russia', code: 'RU' },
  'europe/lisbon': { city: 'Lisbon', country: 'Portugal', code: 'PT' },
  'america/new_york': { city: 'New York', country: 'United States', code: 'US' },
  'america/chicago': { city: 'Chicago', country: 'United States', code: 'US' },
  'america/denver': { city: 'Denver', country: 'United States', code: 'US' },
  'america/los_angeles': { city: 'Los Angeles', country: 'United States', code: 'US' },
  'america/phoenix': { city: 'Phoenix', country: 'United States', code: 'US' },
  'america/detroit': { city: 'Detroit', country: 'United States', code: 'US' },
  'america/toronto': { city: 'Toronto', country: 'Canada', code: 'CA' },
  'america/vancouver': { city: 'Vancouver', country: 'Canada', code: 'CA' },
  'america/montreal': { city: 'Montreal', country: 'Canada', code: 'CA' },
  'america/mexico_city': { city: 'Mexico City', country: 'Mexico', code: 'MX' },
  'america/sao_paulo': { city: 'São Paulo', country: 'Brazil', code: 'BR' },
  'america/buenos_aires': { city: 'Buenos Aires', country: 'Argentina', code: 'AR' },
  'america/bogota': { city: 'Bogota', country: 'Colombia', code: 'CO' },
  'america/lima': { city: 'Lima', country: 'Peru', code: 'PE' },
  'america/santiago': { city: 'Santiago', country: 'Chile', code: 'CL' },
  'australia/sydney': { city: 'Sydney', country: 'Australia', code: 'AU' },
  'australia/melbourne': { city: 'Melbourne', country: 'Australia', code: 'AU' },
  'australia/brisbane': { city: 'Brisbane', country: 'Australia', code: 'AU' },
  'australia/perth': { city: 'Perth', country: 'Australia', code: 'AU' },
  'pacific/auckland': { city: 'Auckland', country: 'New Zealand', code: 'NZ' },
  'africa/cairo': { city: 'Cairo', country: 'Egypt', code: 'EG' },
  'africa/johannesburg': { city: 'Johannesburg', country: 'South Africa', code: 'ZA' },
  'africa/lagos': { city: 'Lagos', country: 'Nigeria', code: 'NG' },
  'africa/nairobi': { city: 'Nairobi', country: 'Kenya', code: 'KE' },
  'africa/casablanca': { city: 'Casablanca', country: 'Morocco', code: 'MA' },
  'africa/douala': { city: 'Douala', country: 'Cameroon', code: 'CM' },
  'africa/yaounde': { city: 'Yaoundé', country: 'Cameroon', code: 'CM' },
};

/** English country name → ISO code for every region Intl knows, built once. */
let intlCountryCodes: Record<string, string> | null = null;
function intlCountryCode(key: string): string | null {
  if (!intlCountryCodes) {
    intlCountryCodes = {};
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const name = names.of(code);
          if (name && name !== code) intlCountryCodes[name.toLowerCase()] = code;
        }
      }
    } catch {}
  }
  return intlCountryCodes[key] || null;
}

export function countryCodeFor(country: string | null | undefined): string | null {
  if (!country) return null;
  const key = country.trim().toLowerCase();
  if (COUNTRY_CODES[key]) return COUNTRY_CODES[key];
  // Already an ISO-3166 alpha-2 code.
  if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
  return intlCountryCode(key);
}

/** ISO code → regional-indicator flag emoji. */
export function flagEmoji(code: string | null): string | null {
  if (!code || code.length !== 2) return null;
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))
  );
}

export interface LocationInfo {
  city: string | null;
  country: string | null;
  countryCode: string | null;
  flag: string | null;
  /** "Lahore, Pakistan" — whatever we can actually say. */
  label: string | null;
  /** True when the stored value is an IANA zone, not a real place. */
  isTimezoneOnly: boolean;
}

/**
 * The widget stores either "City, Country" from IP lookup, or — when that
 * lookup is blocked — the browser's IANA timezone as a fallback. Both arrive in
 * the same column, so they have to be told apart here.
 */
export function parseLocation(
  raw: string | null | undefined,
  city?: string | null,
  country?: string | null
): LocationInfo {
  let c = city?.trim() || null;
  let k = country?.trim() || null;
  let countryCode: string | null = null;

  const value = raw?.trim() || null;
  const looksLikeTimezone = !!value && value.includes('/') && !value.includes(',');

  if (looksLikeTimezone && !c && !k) {
    const tzMatch = TIMEZONE_TO_COUNTRY[value.toLowerCase()];
    if (tzMatch) {
      // A timezone names a country, not a city: every visitor on
      // Asia/Karachi is not in Karachi. Show only what it actually tells us.
      k = tzMatch.country;
      countryCode = tzMatch.code;
    }
  } else if (!c && !k && value && !looksLikeTimezone) {
    const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      c = parts[0];
      k = parts[parts.length - 1];
    } else if (parts.length === 1) {
      k = parts[0];
    }
  }

  if (!countryCode) {
    countryCode = countryCodeFor(k);
  }

  const flag = flagEmoji(countryCode);

  return {
    city: c,
    country: k,
    countryCode,
    flag,
    label: [c, k].filter(Boolean).join(', ') || null,
    isTimezoneOnly: looksLikeTimezone && !c && !k,
  };
}

/* --------------------------------------------------------------- local time */

/** Pulls an IANA timezone out of whatever we stored, if there is one. */
export function timezoneFrom(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return value.includes('/') && !value.includes(',') ? value : null;
}

/**
 * The visitor's own wall-clock time. Returns null for an unknown zone rather
 * than silently falling back to the agent's clock, which would be misleading.
 */
export function localTimeIn(timezone: string | null): string | null {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    })
      .format(new Date())
      .toLowerCase()
      .replace(' ', '');
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- language */

/** "en-IN" → "English (India)", falling back to the raw tag. */
export function languageLabel(tag: string | null | undefined): string | null {
  if (!tag) return null;
  try {
    const [lang, region] = tag.split('-');
    const langName =
      new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) ?? lang;
    if (!region) return langName;
    const regionName =
      new Intl.DisplayNames(['en'], { type: 'region' }).of(region.toUpperCase()) ??
      region;
    return `${langName} (${regionName})`;
  } catch {
    return tag;
  }
}
