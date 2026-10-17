/**
 * Real-time bidirectional translation engine for customer support.
 *
 * Capabilities:
 * 1. Automatic language detection (Arabic, Hindi, Urdu, Spanish, French, German, Russian, Chinese, etc.)
 * 2. Translates customer foreign messages into clear English for support agents in the dashboard
 * 3. Translates agent English replies into the customer's native language with polite, human support tone
 * 4. Dual-layer engine: Uses configured LLM (OpenAI, Gemini, Anthropic, DeepSeek) with zero-config free translation fallback
 */

import { chat, isConfigured, ProviderConfig } from './provider';
import { getPlatformAiConfigServerOnly } from './platform-gateway';

export interface LanguageInfo {
  code: string;
  name: string;
  nativeName?: string;
  flag?: string;
  isRtl?: boolean;
}

export const SUPPORTED_LANGUAGES: Record<string, LanguageInfo> = {
  ab: { code: 'ab', name: 'Abkhazian', nativeName: 'Аҧсшәа', flag: '🇬🇪' },
  af: { code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans', flag: '🇿🇦' },
  ak: { code: 'ak', name: 'Twi', nativeName: 'Twi', flag: '🇬🇭' },
  am: { code: 'am', name: 'Amharic', nativeName: 'አማርኛ', flag: '🇪🇹' },
  ar: { code: 'ar', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦', isRtl: true },
  as: { code: 'as', name: 'Assamese', nativeName: 'অসমীয়া', flag: '🇮🇳' },
  ay: { code: 'ay', name: 'Aymara', nativeName: 'Aymar', flag: '🇧🇴' },
  az: { code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycan', flag: '🇦🇿' },
  be: { code: 'be', name: 'Belarusian', nativeName: 'Беларуская', flag: '🇧🇾' },
  bg: { code: 'bg', name: 'Bulgarian', nativeName: 'Български', flag: '🇧🇬' },
  bho: { code: 'bho', name: 'Bhojpuri', nativeName: 'भोजपुरी', flag: '🇮🇳' },
  bm: { code: 'bm', name: 'Bambara', nativeName: 'Bamanankan', flag: '🇲🇱' },
  bn: { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', flag: '🇧🇩' },
  bs: { code: 'bs', name: 'Bosnian', nativeName: 'Bosanski', flag: '🇧🇦' },
  ca: { code: 'ca', name: 'Catalan', nativeName: 'Català', flag: '🇪🇸' },
  ceb: { code: 'ceb', name: 'Cebuano', nativeName: 'Cebuano', flag: '🇵🇭' },
  ckb: { code: 'ckb', name: 'Kurdish (Sorani)', nativeName: 'کوردی', flag: '🇮🇶', isRtl: true },
  co: { code: 'co', name: 'Corsican', nativeName: 'Corsu', flag: '🇫🇷' },
  cs: { code: 'cs', name: 'Czech', nativeName: 'Čeština', flag: '🇨🇿' },
  cy: { code: 'cy', name: 'Welsh', nativeName: 'Cymraeg', flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
  da: { code: 'da', name: 'Danish', nativeName: 'Dansk', flag: '🇩🇰' },
  de: { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  doi: { code: 'doi', name: 'Dogri', nativeName: 'डोगरी', flag: '🇮🇳' },
  dv: { code: 'dv', name: 'Dhivehi', nativeName: 'ދިވެހި', flag: '🇲🇻', isRtl: true },
  ee: { code: 'ee', name: 'Ewe', nativeName: 'Eʋegbe', flag: '🇬🇭' },
  el: { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', flag: '🇬🇷' },
  en: { code: 'en', name: 'English', nativeName: 'English', flag: '🇬🇧' },
  eo: { code: 'eo', name: 'Esperanto', nativeName: 'Esperanto', flag: '🌐' },
  es: { code: 'es', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  et: { code: 'et', name: 'Estonian', nativeName: 'Eesti', flag: '🇪🇪' },
  eu: { code: 'eu', name: 'Basque', nativeName: 'Euskara', flag: '🇪🇸' },
  fa: { code: 'fa', name: 'Persian', nativeName: 'فارسی', flag: '🇮🇷', isRtl: true },
  fi: { code: 'fi', name: 'Finnish', nativeName: 'Suomi', flag: '🇫🇮' },
  fr: { code: 'fr', name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  fy: { code: 'fy', name: 'Frisian', nativeName: 'Frysk', flag: '🇳🇱' },
  ga: { code: 'ga', name: 'Irish', nativeName: 'Gaeilge', flag: '🇮🇪' },
  gd: { code: 'gd', name: 'Scots Gaelic', nativeName: 'Gàidhlig', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
  gl: { code: 'gl', name: 'Galician', nativeName: 'Galego', flag: '🇪🇸' },
  gn: { code: 'gn', name: 'Guarani', nativeName: 'Avañe\'ẽ', flag: '🇵🇾' },
  gom: { code: 'gom', name: 'Konkani', nativeName: 'कोंकणी', flag: '🇮🇳' },
  gu: { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', flag: '🇮🇳' },
  ha: { code: 'ha', name: 'Hausa', nativeName: 'Hausa', flag: '🇳🇬' },
  haw: { code: 'haw', name: 'Hawaiian', nativeName: 'ʻŌlelo Hawaiʻi', flag: '🇺🇸' },
  he: { code: 'he', name: 'Hebrew', nativeName: 'עברית', flag: '🇮🇱', isRtl: true },
  hi: { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flag: '🇮🇳' },
  hmn: { code: 'hmn', name: 'Hmong', nativeName: 'Hmoob', flag: '🇱🇦' },
  hr: { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski', flag: '🇭🇷' },
  ht: { code: 'ht', name: 'Haitian Creole', nativeName: 'Kreyòl Ayisyen', flag: '🇭🇹' },
  hu: { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', flag: '🇭🇺' },
  hy: { code: 'hy', name: 'Armenian', nativeName: 'Հայերեն', flag: '🇦🇲' },
  id: { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '🇮🇩' },
  ig: { code: 'ig', name: 'Igbo', nativeName: 'Asụsụ Igbo', flag: '🇳🇬' },
  ilo: { code: 'ilo', name: 'Ilocano', nativeName: 'Ilokano', flag: '🇵🇭' },
  is: { code: 'is', name: 'Icelandic', nativeName: 'Íslenska', flag: '🇮🇸' },
  it: { code: 'it', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
  ja: { code: 'ja', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵' },
  jv: { code: 'jv', name: 'Javanese', nativeName: 'Basa Jawa', flag: '🇮🇩' },
  ka: { code: 'ka', name: 'Georgian', nativeName: 'ქართული', flag: '🇬🇪' },
  kk: { code: 'kk', name: 'Kazakh', nativeName: 'Қазақ', flag: '🇰🇿' },
  km: { code: 'km', name: 'Khmer', nativeName: 'ខ្មែរ', flag: '🇰🇭' },
  kn: { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', flag: '🇮🇳' },
  ko: { code: 'ko', name: 'Korean', nativeName: '한국어', flag: '🇰🇷' },
  kri: { code: 'kri', name: 'Krio', nativeName: 'Krio', flag: '🇸🇱' },
  ku: { code: 'ku', name: 'Kurdish (Kurmanji)', nativeName: 'Kurdî', flag: '🇹🇷' },
  ky: { code: 'ky', name: 'Kyrgyz', nativeName: 'Кыргызча', flag: '🇰🇬' },
  la: { code: 'la', name: 'Latin', nativeName: 'Latina', flag: '🇻🇦' },
  lb: { code: 'lb', name: 'Luxembourgish', nativeName: 'Lëtzebuergesch', flag: '🇱🇺' },
  lg: { code: 'lg', name: 'Luganda', nativeName: 'Luganda', flag: '🇺🇬' },
  ln: { code: 'ln', name: 'Lingala', nativeName: 'Lingála', flag: '🇨🇩' },
  lo: { code: 'lo', name: 'Lao', nativeName: 'ລາວ', flag: '🇱🇦' },
  lt: { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', flag: '🇱🇹' },
  lus: { code: 'lus', name: 'Mizo', nativeName: 'Mizo ṭawng', flag: '🇮🇳' },
  lv: { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', flag: '🇱🇻' },
  mai: { code: 'mai', name: 'Maithili', nativeName: 'मैथिली', flag: '🇮🇳' },
  mg: { code: 'mg', name: 'Malagasy', nativeName: 'Malagasy', flag: '🇲🇬' },
  mi: { code: 'mi', name: 'Maori', nativeName: 'Te Reo Māori', flag: '🇳🇿' },
  mk: { code: 'mk', name: 'Macedonian', nativeName: 'Македонски', flag: '🇲🇰' },
  ml: { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', flag: '🇮🇳' },
  mn: { code: 'mn', name: 'Mongolian', nativeName: 'Монгол', flag: '🇲🇳' },
  'mni-mtei': { code: 'mni-mtei', name: 'Meiteilon (Manipuri)', nativeName: 'ꯃꯩꯇꯩꯂꯣꯟ', flag: '🇮🇳' },
  mr: { code: 'mr', name: 'Marathi', nativeName: 'मराठी', flag: '🇮🇳' },
  ms: { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', flag: '🇲🇾' },
  mt: { code: 'mt', name: 'Maltese', nativeName: 'Malti', flag: '🇲🇹' },
  my: { code: 'my', name: 'Myanmar (Burmese)', nativeName: 'မြန်မာ', flag: '🇲🇲' },
  ne: { code: 'ne', name: 'Nepali', nativeName: 'नेपाली', flag: '🇳🇵' },
  nl: { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', flag: '🇳🇱' },
  no: { code: 'no', name: 'Norwegian', nativeName: 'Norsk', flag: '🇳🇴' },
  nso: { code: 'nso', name: 'Sepedi', nativeName: 'Sesotho sa Leboa', flag: '🇿🇦' },
  ny: { code: 'ny', name: 'Chichewa', nativeName: 'Chichewa', flag: '🇲🇼' },
  om: { code: 'om', name: 'Oromo', nativeName: 'Afaan Oromoo', flag: '🇪🇹' },
  or: { code: 'or', name: 'Odia (Oriya)', nativeName: 'ଓଡ଼ିଆ', flag: '🇮🇳' },
  pa: { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
  pl: { code: 'pl', name: 'Polish', nativeName: 'Polski', flag: '🇵🇱' },
  ps: { code: 'ps', name: 'Pashto', nativeName: 'پښتو', flag: '🇦🇫', isRtl: true },
  pt: { code: 'pt', name: 'Portuguese', nativeName: 'Português', flag: '🇵🇹' },
  qu: { code: 'qu', name: 'Quechua', nativeName: 'Runasimi', flag: '🇵🇪' },
  ro: { code: 'ro', name: 'Romanian', nativeName: 'Română', flag: '🇷🇴' },
  ru: { code: 'ru', name: 'Russian', nativeName: 'Русский', flag: '🇷🇺' },
  rw: { code: 'rw', name: 'Kinyarwanda', nativeName: 'Ikinyarwanda', flag: '🇷🇼' },
  sa: { code: 'sa', name: 'Sanskrit', nativeName: 'संस्कृतम्', flag: '🇮🇳' },
  sd: { code: 'sd', name: 'Sindhi', nativeName: 'سنڌي', flag: '🇵🇰', isRtl: true },
  si: { code: 'si', name: 'Sinhala', nativeName: 'සිංහල', flag: '🇱🇰' },
  sk: { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina', flag: '🇸🇰' },
  sl: { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina', flag: '🇸🇮' },
  sm: { code: 'sm', name: 'Samoan', nativeName: 'Gagana Sāmoa', flag: '🇼🇸' },
  sn: { code: 'sn', name: 'Shona', nativeName: 'chiShona', flag: '🇿🇼' },
  so: { code: 'so', name: 'Somali', nativeName: 'Soomaali', flag: '🇸🇴' },
  sq: { code: 'sq', name: 'Albanian', nativeName: 'Shqip', flag: '🇦🇱' },
  sr: { code: 'sr', name: 'Serbian', nativeName: 'Српски', flag: '🇷🇸' },
  st: { code: 'st', name: 'Sesotho', nativeName: 'Sesotho', flag: '🇱🇸' },
  su: { code: 'su', name: 'Sundanese', nativeName: 'Basa Sunda', flag: '🇮🇩' },
  sv: { code: 'sv', name: 'Swedish', nativeName: 'Svenska', flag: '🇸🇪' },
  sw: { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', flag: '🇰🇪' },
  ta: { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', flag: '🇮🇳' },
  te: { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', flag: '🇮🇳' },
  tg: { code: 'tg', name: 'Tajik', nativeName: 'Тоҷикӣ', flag: '🇹🇯' },
  th: { code: 'th', name: 'Thai', nativeName: 'ไทย', flag: '🇹🇭' },
  ti: { code: 'ti', name: 'Tigrinya', nativeName: 'ትግርኛ', flag: '🇪🇷' },
  tk: { code: 'tk', name: 'Turkmen', nativeName: 'Türkmençe', flag: '🇹🇲' },
  tl: { code: 'tl', name: 'Tagalog (Filipino)', nativeName: 'Tagalog', flag: '🇵🇭' },
  tr: { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', flag: '🇹🇷' },
  ts: { code: 'ts', name: 'Tsonga', nativeName: 'Xitsonga', flag: '🇿🇦' },
  tt: { code: 'tt', name: 'Tatar', nativeName: 'Татар', flag: '🇷🇺' },
  ug: { code: 'ug', name: 'Uyghur', nativeName: 'ئۇيغۇرچە', flag: '🇨🇳', isRtl: true },
  uk: { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', flag: '🇺🇦' },
  ur: { code: 'ur', name: 'Urdu', nativeName: 'اردو', flag: '🇵🇰', isRtl: true },
  uz: { code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbek', flag: '🇺🇿' },
  vi: { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', flag: '🇻🇳' },
  xh: { code: 'xh', name: 'Xhosa', nativeName: 'isiXhosa', flag: '🇿🇦' },
  yi: { code: 'yi', name: 'Yiddish', nativeName: 'ייִדיש', flag: '🇮🇱', isRtl: true },
  yo: { code: 'yo', name: 'Yoruba', nativeName: 'Èdè Yorùbá', flag: '🇳🇬' },
  zh: { code: 'zh', name: 'Chinese (Simplified)', nativeName: '中文 (简体)', flag: '🇨🇳' },
  'zh-tw': { code: 'zh-tw', name: 'Chinese (Traditional)', nativeName: '中文 (繁體)', flag: '🇹🇼' },
  zu: { code: 'zu', name: 'Zulu', nativeName: 'isiZulu', flag: '🇿🇦' },
};

/**
 * Every language Google Translate offers (translate_a/l, 249 entries), in
 * Google's own codes. Anything here and not above is added to
 * SUPPORTED_LANGUAGES below, so detection, the dashboard picker and reply
 * translation all cover the full list.
 */
const GOOGLE_LANGUAGES: Record<string, string> = {"ab":"Abkhaz","ace":"Acehnese","ach":"Acholi","aa":"Afar","af":"Afrikaans","sq":"Albanian","alz":"Alur","am":"Amharic","ar":"Arabic","hy":"Armenian","as":"Assamese","av":"Avar","awa":"Awadhi","ay":"Aymara","az":"Azerbaijani","ban":"Balinese","bal":"Baluchi","bm":"Bambara","bci":"Baoulé","ba":"Bashkir","eu":"Basque","btx":"Batak Karo","bts":"Batak Simalungun","bbc":"Batak Toba","be":"Belarusian","bem":"Bemba","bn":"Bengali","bew":"Betawi","bho":"Bhojpuri","bik":"Bikol","bs":"Bosnian","br":"Breton","bg":"Bulgarian","bua":"Buryat","yue":"Cantonese","ca":"Catalan","ceb":"Cebuano","ch":"Chamorro","ce":"Chechen","ny":"Chichewa","zh-CN":"Chinese (Simplified)","zh-TW":"Chinese (Traditional)","chk":"Chuukese","cv":"Chuvash","co":"Corsican","crh":"Crimean Tatar (Cyrillic)","crh-Latn":"Crimean Tatar (Latin)","hr":"Croatian","cs":"Czech","da":"Danish","fa-AF":"Dari","dv":"Dhivehi","din":"Dinka","doi":"Dogri","dov":"Dombe","nl":"Dutch","dyu":"Dyula","dz":"Dzongkha","en":"English","eo":"Esperanto","et":"Estonian","ee":"Ewe","fo":"Faroese","fj":"Fijian","tl":"Filipino","fi":"Finnish","fon":"Fon","fr":"French","fr-CA":"French (Canada)","fy":"Frisian","fur":"Friulian","ff":"Fulani","gaa":"Ga","gl":"Galician","ka":"Georgian","de":"German","el":"Greek","gn":"Guarani","gu":"Gujarati","ht":"Haitian Creole","cnh":"Hakha Chin","ha":"Hausa","haw":"Hawaiian","iw":"Hebrew","hil":"Hiligaynon","hi":"Hindi","hmn":"Hmong","hu":"Hungarian","hrx":"Hunsrik","iba":"Iban","is":"Icelandic","ig":"Igbo","ilo":"Ilocano","id":"Indonesian","iu-Latn":"Inuktut (Latin)","iu":"Inuktut (Syllabics)","ga":"Irish","it":"Italian","jam":"Jamaican Patois","ja":"Japanese","jw":"Javanese","kac":"Jingpo","kl":"Kalaallisut","kn":"Kannada","kr":"Kanuri","pam":"Kapampangan","kk":"Kazakh","kha":"Khasi","km":"Khmer","cgg":"Kiga","kg":"Kikongo","rw":"Kinyarwanda","ktu":"Kituba","trp":"Kokborok","kv":"Komi","gom":"Konkani","ko":"Korean","kri":"Krio","ku":"Kurdish (Kurmanji)","ckb":"Kurdish (Sorani)","ky":"Kyrgyz","lo":"Lao","ltg":"Latgalian","la":"Latin","lv":"Latvian","lij":"Ligurian","li":"Limburgish","ln":"Lingala","lt":"Lithuanian","lmo":"Lombard","lg":"Luganda","luo":"Luo","lb":"Luxembourgish","mk":"Macedonian","mad":"Madurese","mai":"Maithili","mak":"Makassar","mg":"Malagasy","ms":"Malay","ms-Arab":"Malay (Jawi)","ml":"Malayalam","mt":"Maltese","mam":"Mam","gv":"Manx","mi":"Maori","mr":"Marathi","mh":"Marshallese","mwr":"Marwadi","mfe":"Mauritian Creole","chm":"Meadow Mari","mni-Mtei":"Meiteilon (Manipuri)","min":"Minang","lus":"Mizo","mn":"Mongolian","my":"Myanmar (Burmese)","nhe":"Nahuatl (Eastern Huasteca)","ndc-ZW":"Ndau","nr":"Ndebele (South)","new":"Nepalbhasa (Newari)","ne":"Nepali","bm-Nkoo":"NKo","no":"Norwegian","nus":"Nuer","oc":"Occitan","or":"Odia (Oriya)","om":"Oromo","os":"Ossetian","pag":"Pangasinan","pap":"Papiamento","ps":"Pashto","fa":"Persian","pl":"Polish","pt":"Portuguese (Brazil)","pt-PT":"Portuguese (Portugal)","pa":"Punjabi (Gurmukhi)","pa-Arab":"Punjabi (Shahmukhi)","qu":"Quechua","kek":"Qʼeqchiʼ","rom":"Romani","ro":"Romanian","rn":"Rundi","ru":"Russian","se":"Sami (North)","sm":"Samoan","sg":"Sango","sa":"Sanskrit","sat-Latn":"Santali (Latin)","sat":"Santali (Ol Chiki)","gd":"Scots Gaelic","nso":"Sepedi","sr":"Serbian","st":"Sesotho","crs":"Seychellois Creole","shn":"Shan","sn":"Shona","scn":"Sicilian","szl":"Silesian","sd":"Sindhi","si":"Sinhala","sk":"Slovak","sl":"Slovenian","so":"Somali","es":"Spanish","su":"Sundanese","sus":"Susu","sw":"Swahili","ss":"Swati","sv":"Swedish","ty":"Tahitian","tg":"Tajik","ber-Latn":"Tamazight","ber":"Tamazight (Tifinagh)","ta":"Tamil","tt":"Tatar","te":"Telugu","tet":"Tetum","th":"Thai","bo":"Tibetan","ti":"Tigrinya","tiv":"Tiv","tpi":"Tok Pisin","to":"Tongan","lua":"Tshiluba","ts":"Tsonga","tn":"Tswana","tcy":"Tulu","tum":"Tumbuka","tr":"Turkish","tk":"Turkmen","tyv":"Tuvan","ak":"Twi","udm":"Udmurt","uk":"Ukrainian","ur":"Urdu","ug":"Uyghur","uz":"Uzbek","ve":"Venda","vec":"Venetian","vi":"Vietnamese","war":"Waray","cy":"Welsh","wo":"Wolof","xh":"Xhosa","sah":"Yakut","yi":"Yiddish","yo":"Yoruba","yua":"Yucatec Maya","zap":"Zapotec","zu":"Zulu"};

/** Google still uses a few retired ISO codes; these are ours → Google's. */
const OUR_TO_GOOGLE: Record<string, string> = { he: 'iw', jv: 'jw', zh: 'zh-CN', 'zh-tw': 'zh-TW' };
const GOOGLE_TO_OUR: Record<string, string> = {
  iw: 'he', jw: 'jv', in: 'id', ji: 'yi', 'zh-cn': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh-tw', 'zh-hk': 'zh-tw', fil: 'tl', nb: 'no', nn: 'no',
};

/** Any language code (ours, Google's, BCP-47 like "pt-BR") → our lowercase code. */
export function canonicalLanguageCode(code: string | null | undefined): string {
  const c = (code || '').trim().toLowerCase().replace(/_/g, '-');
  if (!c) return 'en';
  if (GOOGLE_TO_OUR[c]) return GOOGLE_TO_OUR[c];
  if (SUPPORTED_LANGUAGES[c]) return c;
  // "pt-br", "ar-latn", "es-419": the base language is what matters.
  const base = c.split('-')[0];
  if (GOOGLE_TO_OUR[base]) return GOOGLE_TO_OUR[base];
  return base;
}

/** Our code → the code Google's endpoints expect ("he" → "iw", "pt-pt" → "pt-PT"). */
export function toGoogleLanguageCode(code: string): string {
  const c = canonicalLanguageCode(code);
  if (OUR_TO_GOOGLE[c]) return OUR_TO_GOOGLE[c];
  const [lang, sub] = c.split('-');
  if (!sub) return lang;
  return `${lang}-${sub.length === 2 ? sub.toUpperCase() : sub[0].toUpperCase() + sub.slice(1)}`;
}

for (const [gCode, name] of Object.entries(GOOGLE_LANGUAGES)) {
  const ours = GOOGLE_TO_OUR[gCode.toLowerCase()] || gCode.toLowerCase();
  if (!SUPPORTED_LANGUAGES[ours]) {
    SUPPORTED_LANGUAGES[ours] = { code: ours, name };
  }
}
for (const code of ['ar', 'fa', 'ur', 'ps', 'sd', 'ug', 'ckb', 'he', 'yi', 'dv', 'pa-arab', 'ms-arab', 'bal']) {
  if (SUPPORTED_LANGUAGES[code]) SUPPORTED_LANGUAGES[code].isRtl = true;
}

/**
 * Languages normally written in a non-Latin script. A visitor who types one of
 * them in Latin letters ("kifak", "privet", "aap kaise hain") is writing it
 * romanized, and should be answered in Latin letters too.
 */
const NON_LATIN_LANGUAGES = new Set([
  'ab', 'am', 'ar', 'as', 'av', 'awa', 'ba', 'be', 'bg', 'bho', 'bn', 'bo', 'bua', 'ce', 'chm', 'ckb',
  'cv', 'doi', 'dv', 'dz', 'el', 'fa', 'fa-af', 'gom', 'gu', 'he', 'hi', 'hy', 'iu', 'ja', 'ka', 'kk',
  'km', 'kn', 'ko', 'kv', 'ky', 'lo', 'mai', 'mk', 'ml', 'mn', 'mni-mtei', 'mr', 'ms-arab', 'mwr', 'my',
  'ne', 'new', 'or', 'os', 'pa', 'pa-arab', 'ps', 'ru', 'sa', 'sah', 'sat', 'sd', 'shn', 'si', 'sr',
  'ta', 'tcy', 'te', 'tg', 'th', 'ti', 'tt', 'tyv', 'udm', 'ug', 'uk', 'ur', 'yi', 'yue', 'zh', 'zh-tw',
  'bal', 'ber', 'crh', 'bm-nkoo',
]);

export function isNonLatinLanguage(code: string | null | undefined): boolean {
  return NON_LATIN_LANGUAGES.has(canonicalLanguageCode(code));
}

/** True when text in this language is written in Latin letters, i.e. romanized. */
export function isRomanizedText(code: string | null | undefined, text: string): boolean {
  return isNonLatinLanguage(code) && isLatinScript(text);
}

/** Google Input Tools transliteration ids (Latin → native script). */
const TRANSLITERATION_IDS: Record<string, string> = {
  zh: 'zh-t-i0-pinyin',
  'zh-tw': 'zh-hant-t-i0-und',
};

/**
 * Turns romanized text back into the language's own script ("kifak" →
 * "كيفك"), which Google can then translate. Google Translate itself leaves
 * most romanized languages untranslated; Hindi is the exception.
 */
export async function transliterateToNative(text: string, code: string): Promise<string | null> {
  const c = canonicalLanguageCode(code);
  const itc = TRANSLITERATION_IDS[c] || `${c.split('-')[0]}-t-i0-und`;

  const one = async (piece: string): Promise<string | null> => {
    try {
      const url =
        `https://inputtools.google.com/request?itc=${encodeURIComponent(itc)}&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8` +
        `&text=${encodeURIComponent(piece)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.[0] !== 'SUCCESS') return null;
      const out = data?.[1]?.[0]?.[1]?.[0];
      return typeof out === 'string' && out.trim() ? out.trim() : null;
    } catch {
      return null;
    }
  };

  // The service stops at the first punctuation mark ("kifak, badde..." came
  // back as just "كيفك"), so each run of words goes separately and the
  // punctuation is put back between them.
  const parts = text.trim().split(/([^\p{L}\p{N}\s']+)/u);
  const converted = await Promise.all(
    parts.map((p, i) => (i % 2 === 1 || !p.trim() ? Promise.resolve(p) : one(p.trim()).then((r) => (r ? ` ${r} ` : null))))
  );
  if (converted.some((p) => p === null)) return null;
  const out = converted.join('').replace(/\s+/g, ' ').trim();
  return out && !isLatinScript(out) ? out : null;
}

export function getLanguageInfo(code: string): LanguageInfo {
  const normalized = (code || 'en').toLowerCase().trim();
  if (SUPPORTED_LANGUAGES[normalized]) return SUPPORTED_LANGUAGES[normalized];
  // Google can detect languages the picker does not list; name them properly
  // instead of showing a bare code.
  let name = normalized.toUpperCase();
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized) || name;
  } catch {}
  return { code: normalized, name };
}

export function isLanguageRtl(code: string): boolean {
  return Boolean(SUPPORTED_LANGUAGES[code?.toLowerCase()]?.isRtl);
}

/**
 * Clean HTML entities commonly returned by web translation APIs.
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}


/** True when the text has letters and every one of them is Latin. */
export function isLatinScript(text: string): boolean {
  const letters = (text || '').replace(/[^\p{L}]/gu, '');
  if (!letters) return false;
  return /^[\p{Script=Latin}]+$/u.test(letters);
}

/**
 * Everyday Roman Urdu / Roman Hindi words. Several of them ("ka", "ki", "se")
 * are too short to prove anything alone, so callers count distinct hits rather
 * than trusting a single match. Words that are also common English ("he",
 * "the", "do", "main", "me", "to") are left out on purpose.
 */
const ROMAN_URDU_TOKENS = new Set([
  'hai', 'hain', 'hy', 'ha', 'ka', 'ki', 'ke', 'ko', 'se', 'ne', 'mein', 'mai', 'mjhe',
  'mera', 'meri', 'mere', 'tera', 'teri', 'apna', 'apni', 'apne', 'nahi', 'nahin', 'nai', 'nhi',
  'kya', 'kia', 'kyun', 'kyu', 'kiun', 'kaise', 'kese', 'kaisa', 'kaisay', 'kab', 'kb', 'kahan',
  'kidhar', 'kidhr', 'aur', 'or', 'bhi', 'tha', 'thi', 'gaya', 'gya', 'gayi', 'gai', 'kar', 'kr',
  'karo', 'kro', 'krna', 'karna', 'karein', 'karen', 'krein', 'kardo', 'krdo', 'krdein', 'ho',
  'hoga', 'hogi', 'hoti', 'hota', 'hua', 'hui', 'raha', 'rha', 'rahi', 'rhi', 'rahe', 'rhe',
  'sakta', 'skta', 'sakti', 'skti', 'sakte', 'skte', 'wala', 'wali', 'wale', 'abhi', 'jaldi',
  'bohat', 'bahut', 'bht', 'boht', 'bohot', 'theek', 'thik', 'thek', 'acha', 'accha', 'ap',
  'aap', 'apko', 'aapko', 'apka', 'aapka', 'apki', 'aapki', 'tum', 'hum', 'hm', 'mujhe',
  'mujhy', 'muje', 'humein', 'hamein', 'hume', 'chahiye', 'chahye', 'chaiye', 'chahie',
  'dein', 'dena', 'lena', 'wapas', 'paise', 'paisa', 'yar', 'yaar', 'bhai', 'ji', 'jee',
  'haan', 'han', 'kuch', 'koi', 'sab', 'yeh', 'ye', 'woh', 'wo', 'iska', 'uska', 'isko',
  'usko', 'kiya', 'diya', 'liya', 'mila', 'mili', 'bata', 'batao', 'btao', 'bataen',
  'bataiye', 'samjh', 'samajh', 'masla', 'maslay', 'shukriya', 'shukria', 'salam', 'assalam',
  'alaikum', 'walekum', 'kitna', 'kitni', 'kitne', 'milega', 'milegi', 'jayega', 'jayegi',
  'ayega', 'aayega', 'denge', 'karenge', 'krenge', 'madad', 'zaroor', 'zarur', 'lekin',
  'magar', 'phir', 'fir', 'jab', 'tab', 'agar', 'kyunke', 'kyunki', 'pehle', 'baad',
]);

/** Number of distinct Roman Urdu words in the text. */
export function romanUrduScore(text: string): number {
  if (!text || !isLatinScript(text)) return 0;
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z]+/)) {
    if (raw && ROMAN_URDU_TOKENS.has(raw)) seen.add(raw);
  }
  return seen.size;
}

/** Roman Urdu / Roman Hindi written in Latin letters. */
export function isRomanUrdu(text: string): boolean {
  if (!text || !isLatinScript(text)) return false;
  const score = romanUrduScore(text);
  if (score >= 2) return !isLikelyEnglishText(text);
  // One strong word ("shukriya", "chahiye") is enough in a short message.
  return score >= 1 && ROMAN_URDU_WORDS_REGEX.test(text) && text.trim().split(/\s+/).length <= 4;
}

/**
 * Primary free translation & auto-detection engine via Google Translate GTX API.
 * High-speed, zero API keys required, covers every language Google offers.
 *
 * With `romanize`, the result is the Latin transliteration of the translation
 * ("aap ka order kal aa jayega", "sawf yasil talabuk ghadan") — what a visitor
 * who types their language in Latin letters can read.
 *
 * Romanized input ("kifak", "privet kak dela", "ami tomake bhalobashi") is
 * recognised by Google but mostly left untranslated, so it is converted back
 * to the language's own script first and translated from there.
 */
export async function translateWithGoogleGtx(
  text: string,
  targetLang: string = 'en',
  sourceLang: string = 'auto',
  options: { romanize?: boolean } = {}
): Promise<{ translated: string; detectedLanguage: string; romanizedSource?: boolean } | null> {
  if (!text || !text.trim()) return null;
  const s = !sourceLang || sourceLang === 'auto' ? 'auto' : toGoogleLanguageCode(sourceLang);
  const t = toGoogleLanguageCode(targetLang || 'en');
  const targetCode = canonicalLanguageCode(targetLang || 'en');

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
      s
    )}&tl=${encodeURIComponent(t)}&dt=t${options.romanize ? '&dt=rm' : ''}&q=${encodeURIComponent(text.trim())}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const segments: any[] = Array.isArray(data?.[0]) ? data[0] : [];
    const candidate = segments
      .filter((x: any) => typeof x?.[0] === 'string')
      .map((x: any) => x[0])
      .join('');
    // With dt=rm, Google appends a segment whose 3rd field is the Latin
    // transliteration of the translated text.
    const romanized = options.romanize
      ? segments
          .filter((x: any) => x?.[0] == null && typeof x?.[2] === 'string')
          .map((x: any) => x[2])
          .join(' ')
          .trim()
      : '';
    // Google answers with its own codes ("iw", "jw", "zh-CN"); ours are ISO.
    let detected = canonicalLanguageCode(data?.[2] || (s === 'auto' ? 'en' : s));
    // e.g. ["ar-Latn"]: Google recognised Arabic typed in Latin letters.
    const detectedScripts: string[] = Array.isArray(data?.[8]?.[3]) ? data[8][3] : [];
    const latnTag = detectedScripts.map(String).find((d) => /-latn$/i.test(d));
    if (latnTag && isNonLatinLanguage(latnTag)) detected = canonicalLanguageCode(latnTag);
    const romanizedSource = isRomanizedText(detected, text) || isRomanUrdu(text);

    // English priority safeguard:
    if (isLikelyEnglishText(text)) {
      detected = 'en';
    } else if ((detected === 'hi' || detected === 'ur') && isLatinScript(text)) {
      // Roman Hindi and Roman Urdu are the same spoken language in Latin
      // letters; Google labels both "hi". Only an unmistakably Hindi greeting
      // keeps the Hindi label.
      detected = ROMAN_HINDI_WORDS_REGEX.test(text) ? 'hi' : 'ur';
    } else if (isRomanUrdu(text)) {
      detected = 'ur';
    }

    // Tagalog false-detection safeguard:
    // Google GTX frequently misclassifies English typos or short informal greetings (e.g. "helow", "helo", "hlo", "hi", "j") as Tagalog ('tl')
    if (detected === 'tl') {
      const TAGALOG_AUTHENTIC_WORDS =
        /\b(kumusta|kamusta|salamat|opo|po|ang|mga|sa|ko|mo|ba|ako|ikaw|siya|ito|iyon|magandang|umaga|hapon|gabi|ano|bakit|paano|kailan|saan|hindi|wala|meron|mayroon|paki|lahat|namin|natin|ninyo|sila|kanila|dito|doon|dyan|gusto|ayaw|puwede|pwede|kailangan|kasi|pero|dahil|para|kung)\b/i;
      const isEnglishGreetingOrShort =
        /^(helow|helo|hello|hlo|hlw|hi|hii|hiii|hey|heyy|ok|okay|k|pls|plz|thanks|thx|yes|no|j)$/i.test(text.trim()) ||
        !TAGALOG_AUTHENTIC_WORDS.test(text);

      if (isEnglishGreetingOrShort) {
        detected = 'en';
      }
    }

    if (candidate && typeof candidate === 'string' && candidate.trim()) {
      let finalTrans = decodeHtmlEntities((romanized || candidate).trim());

      // Romanized text that came back (mostly) unchanged was not translated:
      // write it in its own script and translate that instead.
      if (
        detected !== 'en' &&
        detected !== targetCode &&
        s === 'auto' &&
        romanizedSource &&
        mostlyUnchanged(text, finalTrans)
      ) {
        const native =
          (await transliterateToNative(text, detected)) ||
          (detected === 'ur' ? romanUrduToUrdu(text) : null);
        if (native && !isLatinScript(native)) {
          try {
            const secondPass = await translateWithGoogleGtx(native, targetLang, detected, options);
            if (secondPass?.translated && !mostlyUnchanged(text, secondPass.translated)) {
              finalTrans = secondPass.translated;
            }
          } catch {}
        }
      }

      // Translated to English and came back identical: it was English all
      // along. Google labels lone English words oddly ("purposefully" →
      // Zulu), which used to make the assistant answer in that language.
      if (
        targetCode === 'en' &&
        detected !== 'en' &&
        !romanizedSource &&
        isLatinScript(text) &&
        finalTrans.trim().toLowerCase() === text.trim().toLowerCase()
      ) {
        detected = 'en';
      }

      return {
        translated: finalTrans,
        detectedLanguage: detected,
        romanizedSource: romanizedSource && detected !== 'en',
      };
    }
  } catch (err) {
    console.warn('[translateWithGoogleGtx] fetch error:', err);
  }
  return null;
}

/** True when most words of the output are words of the input: nothing was translated. */
function mostlyUnchanged(input: string, output: string): boolean {
  const words = (v: string) => v.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const inSet = new Set(words(input));
  const out = words(output);
  if (!out.length) return true;
  const kept = out.filter((w) => inSet.has(w)).length;
  return kept / out.length >= 0.6;
}

/**
 * Free translation fallback via MyMemory with zero API keys required.
 */
export async function translateViaFreeApi(
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<string | null> {
  if (!text || !text.trim()) return text;
  const s = sourceLang === 'en' ? 'en' : (sourceLang || 'auto');
  const t = targetLang || 'en';
  if (s === t && s !== 'auto') return text;

  // 1. Primary: Google GTX
  const googleRes = await translateWithGoogleGtx(text, t, s);
  if (googleRes?.translated) {
    return googleRes.translated;
  }

  // 2. Secondary: MyMemory fallback
  try {
    const sPair = s === 'auto' ? 'en' : s;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
      text.trim()
    )}&langpair=${encodeURIComponent(sPair)}|${encodeURIComponent(t)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      const candidate = data?.responseData?.translatedText;
      if (
        candidate &&
        typeof candidate === 'string' &&
        candidate.trim() &&
        !candidate.startsWith('MYMEMORY WARNING:')
      ) {
        return decodeHtmlEntities(candidate.trim());
      }
    }
  } catch (err) {
    console.warn('[translateViaFreeApi] Translation fetch failed:', err);
  }
  return null;
}

export function isLikelyEnglishText(text: string): boolean {
  if (!text || !text.trim()) return true;
  const trimmed = text.trim();

  // If text contains non-Latin scripts (Arabic, Devanagari, Cyrillic, Chinese, etc.), it's not English
  if (
    /[\u0600-\u06FF\u0900-\u097F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0E00-\u0E7F\u0590-\u05FF]/.test(
      trimmed
    )
  ) {
    return false;
  }

  // Roman Urdu borrows English nouns freely ("mera account ka problem hai
  // please help kro"), so nouns like "account" or "help" are no evidence of
  // English. Only English grammar words can outvote Urdu grammar words.
  const urduScore = romanUrduScore(trimmed);
  if (urduScore >= 2) {
    const englishGrammar = unicodeWords(trimmed).filter((w) =>
      /^(the|is|are|am|was|were|i|you|it|we|they|this|that|what|how|why|when|where|which|to|for|with|and|of|my|your|can|could|would|will|have|has|do|does|did|not|an|a|in|on|at|be|been|there|here|if|but)$/.test(w)
    );
    if (urduScore >= englishGrammar.length) return false;
  }

  // Count distinct English grammar/vocabulary words
  const ENGLISH_WORDS_REGEX =
    /\b(the|is|are|am|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|can|could|may|might|must|i|you|he|she|it|we|they|my|your|his|her|its|our|their|what|which|who|whom|whose|where|when|why|how|a|an|in|on|at|to|for|with|from|by|about|into|through|after|over|between|out|against|during|without|before|under|around|among|this|that|these|those|there|here|and|but|or|if|because|as|until|while|of|so|then|than|no|not|only|own|same|too|very|just|now|also|any|some|all|both|each|few|more|most|other|such|account|accounts|problem|issue|help|support|please|thanks|thank|sir|madam|hello|hi|hey|good|morning|evening|afternoon|night|yes|okay|ok|price|prices|cost|rule|rules|loss|losses|drawdown|time|credentials|access|failed|showing|consistency|balance|trading|trade|trades|profit|payout|status|check|update|updated|deposit|withdrawal|funded|instant|holding|amount|minimum|maximum|limit|limits|number|server|platform|login|password|email|link|site|page|step|challenge|percent|percentage|cant|cannot|don't|dont|doesnt|doesn't|wont|won't|want|need|give|take|get|tell|ask|buy|bought|order|service)\b/gi;

  // Whole words only. A \b regex treats accented letters as word breaks, so
  // Vietnamese "tôi" and "của" used to count as the English words "i" and "a".
  const tokens = unicodeWords(trimmed);
  const wholeWord = new RegExp(`^(?:${ENGLISH_WORDS_REGEX.source.replace(/^\\b\(|\)\\b$/g, '')})$`, 'i');
  const matches = tokens.filter((w) => wholeWord.test(w));

  // Text where most words are not English vocabulary and that carries
  // non-English letters (é, ñ, ơ, ß...) is not English.
  if (/[^\x00-\x7F]/.test(trimmed) && matches.length * 2 < tokens.length) {
    return false;
  }

  if (matches.length >= 2) {
    return true;
  }

  if (matches.length >= 1) {
    if (tokens.length <= 4 && matches.length >= Math.ceil(tokens.length / 2)) {
      return true;
    }
  }

  return false;
}

/** Words split on anything that is not a letter, digit or apostrophe, in any script. */
function unicodeWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

const ROMAN_URDU_WORDS_REGEX =
  /\b(humein|humay|hamara|hamari|mein|aap|aapko|apko|aapka|apka|aapki|apki|mera|meri|mere|mujhe|mujhko|mujhy|chahiye|chahye|chahie|shukriya|shukria|theek|thik|hoga|hogi|kya|kaise|kese|kaisay|batao|bataen|bataiye|kitna|kitni|kitne|denge|dainge|karenge|krenge|karen|karo|karein|madad|acha|accha|salam|assalam|walekum|alaikum|nahi|nahin|jayega|jayegi|milega|kidhar|kidhr|kyun|kyu|bolo|bolen|suno|kro|krna|karna|raha|rahi|rahe|pohnchega|paisa|paise|rupay|rupee|kharidna|rabta|rabtah|waghera)\b/i;

const ROMAN_HINDI_WORDS_REGEX =
  /\b(namaste|namaskar|dhanyawad|dhanyavad|kripya|kripaya|kaise ho|kaisi ho|theek hu|theek hoon|pranam|puchna|pucho)\b/i;

/**
 * Normalizes detected language codes with high accuracy for Arabic, Urdu, Persian, Hindi, English, etc.
 */
export function normalizeDetectedLanguage(code: string, text: string): string {
  // Google's legacy codes ("iw" Hebrew, "jw" Javanese, "zh-CN") map to ours;
  // a script tag ("ar-Latn") is dropped, the language kept.
  const c = canonicalLanguageCode(code);
  const trimmed = (text || '').trim();

  // 1. Devanagari script: Hindi, unless the detector named another Devanagari language.
  if (/[\u0900-\u097F]/.test(trimmed)) {
    return ['mr', 'ne', 'sa', 'mai', 'bho', 'doi', 'gom', 'awa', 'mwr', 'new'].includes(c) ? c : 'hi';
  }

  // 1b. PRIORITY ENGLISH CHECK: If the text is clearly English Latin text, ALWAYS return 'en'!
  // Never let country/browser or misdetected 'hi' / 'ur' override authentic English.
  if (isLikelyEnglishText(trimmed)) {
    return 'en';
  }

  // 2. If text is Roman Hindi (Latin transliteration)
  if (ROMAN_HINDI_WORDS_REGEX.test(trimmed)) {
    return 'hi';
  }

  // 3. If text is Roman Urdu (Latin transliteration like "kya haal hai", "mujhe discount chahiye")
  if (ROMAN_URDU_WORDS_REGEX.test(trimmed) || isRomanUrdu(trimmed)) {
    return 'ur';
  }

  // 3b. A detector that already said Hindi/Urdu for Latin text, with at least
  // one Urdu word to back it up, is describing Roman Urdu.
  if ((c === 'hi' || c === 'ur') && isLatinScript(trimmed) && romanUrduScore(trimmed) >= 1) {
    return 'ur';
  }

  // 4. If text contains Arabic/Persian/Urdu script ([\u0600-\u06FF])
  if (/[\u0600-\u06FF]/.test(trimmed)) {
    // If explicitly identified as Arabic, Persian, Pashto, Sindhi, Uyghur, or Kurdish, respect that code:
    if (['ar', 'fa', 'fa-af', 'ps', 'sd', 'ug', 'ckb', 'pa-arab', 'ms-arab', 'bal'].includes(c)) {
      return c;
    }
    if (c === 'ur') {
      // Check if it's true Urdu or Arabic misclassified as Urdu
      if (
        /[ٹڈڑںے]/.test(trimmed) ||
        /\b(کیا|ہیں|ہے|نہیں|آپ|کیوں|کیسے|شکریہ|چاہیے|بتائیں|بتائیے|ہوں|ہوگا|ہوگی|تھا|تھی|تھے|مجھے|مجھکو|ہماری|ہمارا|ہمارے|کرو|کریں|کرنا)\b/.test(trimmed)
      ) {
        return 'ur';
      }
      // If it contains common Arabic words, it is Arabic (not Urdu)
      if (/\b(مرحبا|أهلا|اهلا|كيف|حالك|سعر|شكرا|أريد|اريد|هذا|هذه|من فضلك|لو سمحت|السلام عليكم|نعم|لا|ماذا|لماذا|اين|أين|متى|كم|معلومات|خدمة)\b/.test(trimmed)) {
        return 'ar';
      }
      return 'ur';
    }

    // If code was misdetected as 'en', 'sw', 'id', 'so', etc., identify by alphabet/lexicon:
    if (
      /[ٹڈڑںے]/.test(trimmed) ||
      /\b(کیا|ہیں|ہے|نہیں|آپ|کیوں|کیسے|شکریہ|چاہیے|بتائیں|بتائیے|ہوں|ہوگا|ہوگی|تھا|تھی|تھے|مجھے|مجھکو|ہماری|ہمارا|ہمارے|کرو|کریں|کرنا)\b/.test(trimmed)
    ) {
      return 'ur';
    }
    if (/[گچپژ]/.test(trimmed)) {
      return 'fa';
    }
    if (/[ښځڅډړڼږ]/.test(trimmed)) {
      return 'ps';
    }
    if (/[ٻڄݙڳڱ]/.test(trimmed)) {
      return 'sd';
    }
    return 'ar';
  }

  // 4b. Cyrillic scripts distinction
  if (/[\u0400-\u052F]/.test(trimmed)) {
    const CYR_BOUND = '(?:^|[^a-zA-Z\\u0400-\\u052F])';
    const CYR_END = '(?:$|[^a-zA-Z\\u0400-\\u052F])';

    // 1. Ukrainian (check before Kazakh because of shared 'і')
    if (
      /[їєґЇЄҐ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(привіт|вітаю|дякую|будь ласка|як справи|доброго|дня)' + CYR_END, 'i').test(trimmed) ||
      (/[іІ]/.test(trimmed) && !/[әғқңөұүһӘҒҚҢӨҰҮҺ]/.test(trimmed))
    ) {
      return 'uk';
    }

    // 2. Abkhazian specific letters: ԥ, ҟ, ӡ, ҵ, ҷ, ҭ (NOT in Kazakh/Uzbek)
    if (
      /[ԥҟӡҵҷҭԤҞӠҴҶҬ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(шәшԥаҟоу|бзиала|итабуп)' + CYR_END, 'i').test(trimmed)
    ) {
      return 'ab';
    }

    // 3. Uzbek specific letters & vocabulary: ў, or Uzbek vocabulary words
    if (
      /[ўЎ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(салом|ассалому|алайкум|қандайсиз|қалайсиз|хайр|ёрдам|беринг|рахмат|раҳмат|илтимос|нархи|қанча|пул|мен|сиз|биз|нима|керак|яхши|бу)' + CYR_END, 'i').test(trimmed)
    ) {
      return 'uz';
    }

    // 4. Kazakh specific letters: ә, ғ, қ, ң, ө, ұ, ү, һ
    if (
      /[әғқңөұүһӘҒҚҢӨҰҮҺ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(сәлем|сәлеметсіз|қалайсыз|рахмет|көмек)' + CYR_END, 'i').test(trimmed)
    ) {
      return 'kk';
    }

    // 5. Belarusian: ў
    if (/[ўЎ]/.test(trimmed)) {
      return 'be';
    }

    // 6. Tajik: ӣ, ӯ, ҷ
    if (/[ӣӯҷӢӮҶ]/.test(trimmed)) {
      return 'tg';
    }

    // 7. Serbian / Macedonian
    if (/[ђћџљњјЂЋЏЉЊЈ]/.test(trimmed)) {
      return 'sr';
    }
    if (/[ѓѕќЃЅЌ]/.test(trimmed)) {
      return 'mk';
    }

    // 8. Bulgarian
    if (new RegExp(CYR_BOUND + '(здравейте|здрасти|благодаря|моля|как сте|колко)' + CYR_END, 'i').test(trimmed)) {
      return 'bg';
    }
  }

  // 4c. Uzbek Latin words
  if (
    /\b(salom|assalomu\s+alaykum|qandaysiz|qalaysiz|yordam|bering|rahmat|iltimos|narxi|qancha|hisob|kerak|yaxshi)\b/i.test(
      trimmed
    ) ||
    /[oOgG][ʻ‘]/.test(trimmed)
  ) {
    return 'uz';
  }

  // 5-6. Hindi/Urdu reported for Latin text that is not English (checked in
  // 1b) is Roman Urdu/Hindi \u2014 the same spoken language, labelled Urdu here.
  // Anything that is not even Latin letters was misdetected.
  if ((c === 'hi' || c === 'ur') && !/[\u0900-\u097F\u0600-\u06FF]/.test(trimmed)) {
    return isLatinScript(trimmed) ? 'ur' : 'en';
  }

  // 7. Any language Google can translate is kept as detected. (Unknown codes
  // used to collapse to English here, which is why Hebrew — reported by
  // Google as "iw" — was never translated.)
  if (c && SUPPORTED_LANGUAGES[c]) {
    return c;
  }
  const base = c.split('-')[0];
  if (base && SUPPORTED_LANGUAGES[base]) {
    return base;
  }

  return 'en';
}

/**
 * Detects the language of a customer message.
 */
export function detectLanguage(text: string): { code: string; name: string } {
  if (!text || !text.trim()) return { code: 'en', name: 'English' };
  const trimmed = text.trim();

  // Fast-track common English greetings, single letters, and typos
  if (
    /^(helow|helo|hello|hlo|hlw|hi|hii|hiii|hey|heyy|ok|okay|k|yes|yeah|yup|no|nope|pls|plz|thanks|thank\s+you|thx|ty|welcome|good\s+morning|good\s+afternoon|good\s+evening|good\s+night|tc|gm|gn|[a-z])$/i.test(
      trimmed
    )
  ) {
    return { code: 'en', name: 'English' };
  }

  // Fast-track English text
  if (isLikelyEnglishText(trimmed)) {
    return { code: 'en', name: 'English' };
  }

  // Fast-track Hindi / Urdu greetings
  if (/^(namaste|namaskar|pranam)$/i.test(trimmed)) {
    return { code: 'hi', name: 'Hindi' };
  }
  if (/^(salam|assalam|assalamu\s+alaikum|walekum\s+assalam)$/i.test(trimmed)) {
    return { code: 'ur', name: 'Urdu (Roman)' };
  }

  // Arabic / Urdu / Persian / Pashto script detection
  if (/[\u0600-\u06FF]/.test(trimmed)) {
    // Urdu-specific letters (ٹڈڑںے) or Urdu-unique grammar words
    if (
      /[ٹڈڑںے]/.test(trimmed) ||
      /\b(کیا|ہیں|ہے|نہیں|آپ|کیوں|کیسے|شکریہ|چاہیے|بتائیں|بتائیے|ہوں|ہوگا|ہوگی|تھا|تھی|تھے|مجھے|مجھکو|ہماری|ہمارا|ہمارے|کرو|کریں|کرنا)\b/.test(trimmed)
    ) {
      return { code: 'ur', name: 'Urdu' };
    }
    // Pashto specific: ښځڅډړڼږ
    if (/[ښځڅډړڼږ]/.test(trimmed)) {
      return { code: 'ps', name: 'Pashto' };
    }
    // Sindhi specific: ٻڄݙڳڱ
    if (/[ٻڄݙڳڱ]/.test(trimmed)) {
      return { code: 'sd', name: 'Sindhi' };
    }
    // Persian specific: گچپژ
    if (/[گچپژ]/.test(trimmed)) {
      return { code: 'fa', name: 'Persian' };
    }
    // Standard Arabic
    return { code: 'ar', name: 'Arabic' };
  }

  // Hebrew script
  if (/[\u0590-\u05FF]/.test(trimmed)) {
    return { code: 'he', name: 'Hebrew' };
  }

  // Devanagari script (Hindi / Marathi)
  if (/[\u0900-\u097F]/.test(trimmed)) {
    return { code: 'hi', name: 'Hindi' };
  }

  // Bengali script
  if (/[\u0980-\u09FF]/.test(trimmed)) {
    return { code: 'bn', name: 'Bengali' };
  }

  // Gurmukhi script (Punjabi)
  if (/[\u0A00-\u0A7F]/.test(trimmed)) {
    return { code: 'pa', name: 'Punjabi' };
  }

  // Gujarati script
  if (/[\u0A80-\u0AFF]/.test(trimmed)) {
    return { code: 'gu', name: 'Gujarati' };
  }

  // Tamil script
  if (/[\u0B80-\u0BFF]/.test(trimmed)) {
    return { code: 'ta', name: 'Tamil' };
  }

  // Telugu script
  if (/[\u0C00-\u0C7F]/.test(trimmed)) {
    return { code: 'te', name: 'Telugu' };
  }

  // Thai script
  if (/[\u0E00-\u0E7F]/.test(trimmed)) {
    return { code: 'th', name: 'Thai' };
  }

  // Greek script
  if (/[\u0370-\u03FF]/.test(trimmed)) {
    return { code: 'el', name: 'Greek' };
  }

  // Japanese (Hiragana / Katakana / Kanji)
  if (/[\u3040-\u30ff]/.test(trimmed)) {
    return { code: 'ja', name: 'Japanese' };
  }

  // Korean (Hangul)
  if (/[\uac00-\ud7af]/.test(trimmed)) {
    return { code: 'ko', name: 'Korean' };
  }

  // Chinese script
  if (/[\u4e00-\u9fa5]/.test(trimmed)) {
    return { code: 'zh', name: 'Chinese' };
  }

  // Cyrillic scripts (Abkhaz, Uzbek, Kazakh, Kyrgyz, Tajik, Ukrainian, Belarusian, Serbian, Macedonian, Bulgarian, Russian)
  if (/[\u0400-\u052F]/.test(trimmed)) {
    const CYR_BOUND = '(?:^|[^a-zA-Z\\u0400-\\u052F])';
    const CYR_END = '(?:$|[^a-zA-Z\\u0400-\\u052F])';

    // 1. Ukrainian (check before Kazakh because of shared 'і')
    if (
      /[їєґЇЄҐ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(привіт|вітаю|дякую|будь ласка|як справи|доброго|дня)' + CYR_END, 'i').test(trimmed) ||
      (/[іІ]/.test(trimmed) && !/[әғқңөұүһӘҒҚҢӨҰҮҺ]/.test(trimmed))
    ) {
      return { code: 'uk', name: 'Ukrainian' };
    }

    // 2. Abkhazian specific letters: ԥ, ҟ, ӡ, ҵ, ҷ, ҭ (NOT in Kazakh/Uzbek)
    if (
      /[ԥҟӡҵҷҭԤҞӠҴҶҬ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(шәшԥаҟоу|бзиала|итабуп)' + CYR_END, 'i').test(trimmed)
    ) {
      return { code: 'ab', name: 'Abkhazian' };
    }

    // 3. Uzbek specific letters & vocabulary: ў, or Uzbek vocabulary words
    if (
      /[ўЎ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(салом|ассалому|алайкум|қандайсиз|қалайсиз|хайр|ёрдам|беринг|рахмат|раҳмат|илтимос|нархи|қанча|пул|мен|сиз|биз|нима|керак|яхши|бу)' + CYR_END, 'i').test(trimmed)
    ) {
      return { code: 'uz', name: 'Uzbek' };
    }

    // 4. Kazakh specific letters: ә, ғ, қ, ң, ө, ұ, ү, һ
    if (
      /[әғқңөұүһӘҒҚҢӨҰҮҺ]/.test(trimmed) ||
      new RegExp(CYR_BOUND + '(сәлем|сәлеметсіз|қалайсыз|рахмет|көмек)' + CYR_END, 'i').test(trimmed)
    ) {
      return { code: 'kk', name: 'Kazakh' };
    }

    // 5. Belarusian: ў
    if (/[ўЎ]/.test(trimmed)) {
      return { code: 'be', name: 'Belarusian' };
    }

    // 6. Tajik: ӣ, ӯ, ҷ
    if (/[ӣӯҷӢӮҶ]/.test(trimmed)) {
      return { code: 'tg', name: 'Tajik' };
    }

    // 7. Serbian / Macedonian
    if (/[ђћџљњјЂЋЏЉЊЈ]/.test(trimmed)) {
      return { code: 'sr', name: 'Serbian' };
    }
    if (/[ѓѕќЃЅЌ]/.test(trimmed)) {
      return { code: 'mk', name: 'Macedonian' };
    }

    // 8. Bulgarian
    if (new RegExp(CYR_BOUND + '(здравейте|здрасти|благодаря|моля|как сте|колко)' + CYR_END, 'i').test(trimmed)) {
      return { code: 'bg', name: 'Bulgarian' };
    }

    // 9. Default Cyrillic to Russian
    return { code: 'ru', name: 'Russian' };
  }

  // Vietnamese diacritics (authentic Vietnamese letters: đ, ư, ơ, ă, or specific Vietnamese tone marks)
  if (/[đươă]/i.test(trimmed) || /[ầấậẩẫằắặẳẵềếệểễồốộổỗờớợởỡừứựửữỳỵỷỹạảãẹẻẽịỉĩọỏõụủũ]/i.test(trimmed)) {
    return { code: 'vi', name: 'Vietnamese' };
  }

  const lower = trimmed.toLowerCase();

  // Roman Urdu before the European word lists: "wo" is German, "se" is
  // Spanish and "come" is Italian, but "wo kab aayega" is none of those.
  if (romanUrduScore(lower) >= 2 && !ROMAN_HINDI_WORDS_REGEX.test(lower)) {
    return { code: 'ur', name: 'Urdu (Roman)' };
  }

  // Uzbek patterns (Latin script)
  if (
    /\b(salom|assalomu\s+alaykum|qandaysiz|qalaysiz|yordam|bering|rahmat|iltimos|narxi|qancha|hisob|kerak|yaxshi)\b/i.test(
      lower
    ) ||
    /[oOgG][ʻ‘]/.test(trimmed)
  ) {
    return { code: 'uz', name: 'Uzbek' };
  }

  // Turkish patterns (check before French to avoid 'ü' or 'ç' collisions)
  if (
    /\b(merhaba|selam|nasil|nasilsiniz|fiyat|fiyatı|ucret|yardim|tesekkur|tesekkür|lutfen|lütfen|kadar|urun|ürün|ürünün)\b/i.test(
      lower
    ) ||
    /[ğışİ]/.test(trimmed)
  ) {
    return { code: 'tr', name: 'Turkish' };
  }

  // Italian patterns (check before Roman Urdu to avoid collisions like 'ho', 'carta', etc.)
  if (
    /\b(ciao|buongiorno|buonasera|grazie|mille|quanto|costa|prezzo|aiuto|carta|pagamento|sconto|adesso|posso|effettuare|domani|mattina|ricarico|codice|disponibile|per favore|come|avrò|oppure|faccio|risulta)\b/i.test(
      lower
    )
  ) {
    return { code: 'it', name: 'Italian' };
  }

  // Spanish patterns
  if (
    /\b(hola|por favor|gracias|buenos|dias|noches|cuanto|cuánto|cuesta|precio|ayuda|ayudar|ayudarle|podemos|puedo|necesito|quiero|donde|dónde|cuando|cuándo|orden|pedido|descuento|este|esta|producto)\b/i.test(
      lower
    ) ||
    /[¿¡ñ]/.test(lower)
  ) {
    return { code: 'es', name: 'Spanish' };
  }

  // French patterns
  if (
    /\b(bonjour|bonsoir|merci|combien|coute|coûte|prix|aide|aider|pouvons|besoin|ou|où|quand|comment|salut|commande)\b/i.test(
      lower
    ) ||
    /[éàèùâêîôûëïœæç]/.test(lower)
  ) {
    return { code: 'fr', name: 'French' };
  }

  // German patterns
  if (
    /\b(hallo|guten|morgen|tag|danke|bitte|wieviel|kostet|preis|hilfe|helfen|können|brauche|wo|wann|wie|bestellung|rabatt|dieses|produkt)\b/i.test(
      lower
    ) ||
    /[äöüß]/.test(lower)
  ) {
    return { code: 'de', name: 'German' };
  }

  // Portuguese patterns
  if (
    /\b(ola|olá|obrigado|obrigada|quanto|custa|preco|preço|ajuda|preciso|por favor)\b/i.test(
      lower
    )
  ) {
    return { code: 'pt', name: 'Portuguese' };
  }

  // Indonesian / Malay patterns
  if (
    /\b(selamat|pagi|siang|malam|terima|kasih|berapa|harganya|bisa|bantu|saya|tolong)\b/i.test(
      lower
    )
  ) {
    return { code: 'id', name: 'Indonesian' };
  }

  // Dutch patterns
  if (
    /\b(hallo|goedemorgen|goedenavond|bedankt|alsjeblieft|hoeveel|kost|prijs|hulp|nodig)\b/i.test(
      lower
    )
  ) {
    return { code: 'nl', name: 'Dutch' };
  }

  // Polish patterns
  if (
    /\b(cześć|dzień|dobry|dziękuję|proszę|ile|kosztuje|cena|pomoc)\b/i.test(lower) ||
    /[ąćęłńóśźż]/i.test(lower)
  ) {
    return { code: 'pl', name: 'Polish' };
  }

  // Swedish patterns
  if (
    /\b(hej|tack|snälla|hur|mycket|kostar|pris|hjälp|behöver)\b/i.test(lower) ||
    /[åäö]/i.test(lower)
  ) {
    return { code: 'sv', name: 'Swedish' };
  }

  // Roman Hindi patterns (Latin script)
  if (ROMAN_HINDI_WORDS_REGEX.test(lower)) {
    return { code: 'hi', name: 'Hindi' };
  }

  // Roman Urdu / Hindi patterns (Latin script)
  if (ROMAN_URDU_WORDS_REGEX.test(lower)) {
    return { code: 'ur', name: 'Urdu (Roman)' };
  }

  // Default to English
  return { code: 'en', name: 'English' };
}

/**
 * Translates customer text into English for support agents in the dashboard.
 * Auto-detects foreign languages (including Italian, Arabic, Urdu, Spanish, etc.) and guarantees English output.
 */
export async function translateToEnglish({
  text,
  detectedLanguage,
  providerConfig,
}: {
  text: string;
  detectedLanguage?: string;
  providerConfig?: ProviderConfig | null;
}): Promise<{
  englishText: string;
  sourceLanguage: string;
  detectedLanguageCode: string;
  isOriginalEnglish: boolean;
}> {
  if (!text || !text.trim()) {
    return {
      englishText: text || '',
      sourceLanguage: 'English',
      detectedLanguageCode: 'en',
      isOriginalEnglish: true,
    };
  }

  const trimmed = text.trim();

  // If text has only numbers, punctuation, or emojis (e.g. "5000", "???"),
  // or is plainly English, there is nothing to translate \u2014 and no reason to
  // spend a model call finding that out.
  if (!/[a-zA-Z\u00C0-\uFFFF]/.test(trimmed) || isLikelyEnglishText(trimmed)) {
    return {
      englishText: trimmed,
      sourceLanguage: 'English',
      detectedLanguageCode: 'en',
      isOriginalEnglish: true,
    };
  }

  // "Roman Urdu", "Roman Arabic", "Roman Russian": the language, typed in Latin letters.
  const nameFor = (code: string) =>
    isRomanizedText(code, trimmed) ? `Roman ${getLanguageInfo(code).name}` : getLanguageInfo(code).name;

  // 1. Try AI provider if configured in platform settings
  const activeConfig = isConfigured(providerConfig)
    ? providerConfig
    : (await getPlatformAiConfigServerOnly()).config;

  if (isConfigured(activeConfig)) {
    try {
      const res = await chat(activeConfig!, {
        system:
          'You are a professional real-time customer support translator.\n' +
          'Translate the customer message into clear, natural, accurate English so the support agent can easily understand their issue or question.\n' +
          'The message may be in any language, including a language typed in Latin letters (Roman Urdu/Hindi, Arabizi such as "kifak 3amel", transliterated Russian, Bengali, Persian, Greek, Hebrew, etc.) — translate those too, and report the language itself (e.g. "ar" for Arabizi).\n' +
          'Preserve all numbers, proper nouns, emails, and links exactly as they are.\n' +
          'Respond with ONLY a JSON object: {"english_text": "...", "detected_language": "ISO 639-1 code", "is_original_english": boolean}',
        messages: [{ role: 'user', content: trimmed }],
        maxTokens: 500,
        temperature: 0,
        reasoning: 'fast',
        timeoutMs: 6000,
      });

      const raw = res.text?.trim() || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.english_text) {
          const code = normalizeDetectedLanguage(parsed.detected_language || 'en', trimmed);
          return {
            englishText: parsed.english_text.trim(),
            sourceLanguage: nameFor(code),
            detectedLanguageCode: code,
            isOriginalEnglish: Boolean(parsed.is_original_english || (code === 'en' && parsed.english_text.trim() === trimmed)),
          };
        }
      }
    } catch (err) {
      console.warn('[translateToEnglish] AI Provider error, falling back to Google engine:', err);
    }
  }

  // 2. High-speed Google GTX translation & language auto-detection
  const googleRes = await translateWithGoogleGtx(trimmed, 'en', 'auto');
  if (googleRes) {
    const code = googleRes.romanizedSource
      ? googleRes.detectedLanguage
      : normalizeDetectedLanguage(googleRes.detectedLanguage || 'en', trimmed);
    const isNonEnglish = code !== 'en';

    return {
      englishText: googleRes.translated,
      sourceLanguage: nameFor(code),
      detectedLanguageCode: code,
      isOriginalEnglish: !isNonEnglish,
    };
  }

  // 3. Fallback: MyMemory
  const heuristic = detectedLanguage
    ? { code: detectedLanguage, name: getLanguageInfo(detectedLanguage).name }
    : detectLanguage(trimmed);

  if (heuristic.code !== 'en') {
    const freeTranslation = await translateViaFreeApi(trimmed, heuristic.code, 'en');
    if (freeTranslation) {
      return {
        englishText: freeTranslation,
        sourceLanguage: heuristic.name,
        detectedLanguageCode: heuristic.code,
        isOriginalEnglish: false,
      };
    }
  }

  return {
    englishText: trimmed,
    sourceLanguage: heuristic.name,
    detectedLanguageCode: heuristic.code,
    isOriginalEnglish: heuristic.code === 'en',
  };
}

/**
 * Common Roman Urdu words/phrases mapped to standard Urdu script.
 * Enables zero-config free translation engines to parse Roman Urdu text.
 */
const ROMAN_URDU_DICTIONARY: Record<string, string> = {
  hum: 'ہم',
  hm: 'ہم',
  ham: 'ہم',
  humein: 'ہمیں',
  humay: 'ہمیں',
  main: 'میں',
  mein: 'میں',
  me: 'میں',
  aap: 'آپ',
  ap: 'آپ',
  tum: 'تم',
  aapki: 'آپ کی',
  apki: 'آپ کی',
  aapka: 'آپ کا',
  apka: 'آپ کا',
  aapko: 'آپ کو',
  apko: 'آپ کو',
  madad: 'مدد',
  help: 'مدد',
  karenge: 'کریں گے',
  krenge: 'کریں گے',
  karengay: 'کریں گے',
  karen: 'کریں',
  karo: 'کریں',
  karna: 'کرنا',
  denge: 'دیں گے',
  dainge: 'دیں گے',
  den: 'دیں',
  discount: 'رعایت',
  off: 'رعایت',
  mil: 'مل',
  jayega: 'جائے گا',
  jayegi: 'جائے گی',
  milega: 'ملے گا',
  milegi: 'ملے گی',
  shukriya: 'شکریہ',
  shukria: 'شکریہ',
  thanks: 'شکریہ',
  chahiye: 'چاہیے',
  chahye: 'چاہیے',
  chahie: 'چاہیے',
  theek: 'ٹھیک',
  thik: 'ٹھیک',
  acha: 'اچھا',
  accha: 'اچھا',
  kya: 'کیا',
  kia: 'کیا',
  kaise: 'کیسے',
  kese: 'کیسے',
  kaisay: 'کیسے',
  kitna: 'کتنا',
  kitni: 'کتنی',
  kitne: 'کتنے',
  batao: 'بتائیں',
  bataiye: 'بتائیں',
  bataen: 'بتائیں',
  hai: 'ہے',
  hain: 'ہیں',
  hoga: 'ہوگا',
  hogi: 'ہوگی',
  nahi: 'نہیں',
  nahin: 'نہیں',
  mat: 'مت',
  salam: 'السلام علیکم',
  assalam: 'السلام علیکم',
  walekum: 'وعلیکم السلام',
  yes: 'جی ہاں',
  haan: 'ہاں',
  ji: 'جی',
  price: 'قیمت',
  rate: 'قیمت',
  keemat: 'قیمت',
  order: 'آرڈر',
  delivery: 'ڈلیوری',
  bhai: 'بھائی',
  bhaia: 'بھائی',
  bhaiya: 'بھائی',
  bro: 'بھائی',
  kab: 'کب',
  kahan: 'کہاں',
  kidhar: 'کدھر',
  kyun: 'کیوں',
  kyu: 'کیوں',
  yar: 'یار',
  yaar: 'یار',
  bolo: 'بولیں',
  bolen: 'بولیں',
  bata: 'بتائیں',
  sun: 'سنیں',
  suno: 'سنیں',
  krna: 'کرنا',
  kro: 'کریں',
  kr: 'کر',
  raha: 'رہا',
  rahi: 'رہی',
  rahe: 'رہے',
  mila: 'ملا',
  mile: 'ملے',
  miley: 'ملے',
  lena: 'لینا',
  lo: 'لیں',
  lelo: 'لیں',
  dena: 'دینا',
  dedo: 'دیں',
  dein: 'دیں',
  pohncha: 'پہنچا',
  pohnchega: 'پہنچے گا',
  paisa: 'پیسہ',
  paise: 'پیسے',
  rupay: 'روپے',
  rupee: 'روپے',
  rs: 'روپے',
  alaikum: 'وعلیکم السلام',
  wapas: 'واپس',
  kharidna: 'خریدنا',
  masla: 'مسئلہ',
  rabta: 'رابطہ',
};

export function romanUrduToUrdu(text: string): string {
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((word) => {
      const clean = word.toLowerCase().replace(/[^a-z]/g, '');
      if (ROMAN_URDU_DICTIONARY[clean]) {
        return word.toLowerCase().replace(clean, ROMAN_URDU_DICTIONARY[clean]);
      }
      return word;
    })
    .join(' ');
}

export interface AgentReplyTranslationResult {
  translatedText: string;
  englishText: string;
  detectedSourceLanguage: string;
  sourceLanguageName: string;
  targetLanguage: string;
  targetLanguageName: string;
  isTranslated: boolean;
}

/**
 * Translates support agent's reply from ANY language (English, Roman Urdu, Urdu, Hindi, Spanish, French, etc.)
 * into the customer's native target language, while also generating/preserving an English version for the agent's dashboard.
 */
export async function translateAgentReply({
  text,
  targetLanguageCode,
  sourceLanguageCode,
  providerConfig,
  businessName,
  romanize = false,
}: {
  text: string;
  targetLanguageCode: string;
  sourceLanguageCode?: string;
  providerConfig?: ProviderConfig | null;
  businessName?: string;
  /** The visitor writes this language in Latin letters (Roman Urdu / Hindi). */
  romanize?: boolean;
}): Promise<AgentReplyTranslationResult> {
  if (!text || !text.trim()) {
    const target = targetLanguageCode || 'en';
    return {
      translatedText: text,
      englishText: text,
      detectedSourceLanguage: 'en',
      sourceLanguageName: 'English',
      targetLanguage: target,
      targetLanguageName: getLanguageInfo(target).name,
      isTranslated: false,
    };
  }

  const targetLang = targetLanguageCode || 'en';
  const targetLangInfo = getLanguageInfo(targetLang);
  // Only meaningful for languages with their own script (Arabic, Hindi,
  // Russian, Bengali, Hebrew, Greek...); Spanish is Latin already.
  const romanTarget = romanize && isNonLatinLanguage(targetLang);
  const targetLabel = romanTarget
    ? `${targetLangInfo.name} written in Latin/English letters (Roman ${targetLangInfo.name}, the way the customer types it — e.g. Roman Urdu "aap ka order kal tak pohanch jayega", Arabizi "talabak rah yousal bokra") — never use the native script`
    : targetLangInfo.name;

  // 1. Try AI provider if configured in platform settings
  const activeConfig = isConfigured(providerConfig)
    ? providerConfig
    : (await getPlatformAiConfigServerOnly()).config;

  if (isConfigured(activeConfig)) {
    try {
      const brandContext = businessName ? ` representing ${businessName}` : '';
      const res = await chat(activeConfig!, {
        system:
          `You are an expert real-time multilingual customer support translation system${brandContext}.\n` +
          `A support agent wrote a reply to a customer in their preferred language (could be English, Roman Urdu, Urdu, Hindi, Spanish, French, Arabic, German, etc.).\n` +
          `The customer speaks: ${targetLabel} (language code: "${targetLang}").\n\n` +
          `Your task:\n` +
          `1. "customer_text": Translate the agent's message into natural, polite, respectful, and friendly ${targetLabel} for the customer. If target is English, provide clear English.\n` +
          `2. "english_text": Translate the agent's message into clear, natural, professional English for the support agent's dashboard. If the agent typed in English, keep it in English.\n` +
          `3. "detected_source_language": The 2-letter ISO code of the language the agent wrote in.\n\n` +
          `Important:\n` +
          `- Accurately understand Roman Urdu/Hindi Latin transliterations (e.g. "hum aapko 20% discount denge" -> English: "We will give you a 20% discount", translated to customer language).\n` +
          `- Keep all numbers, prices, URLs, emails, codes, and proper names untouched.\n` +
          `- Respond with ONLY a valid JSON object matching: {"customer_text": "...", "english_text": "...", "detected_source_language": "..."}`,
        messages: [{ role: 'user', content: text }],
        maxTokens: 1000,
        temperature: 0.1,
        reasoning: 'fast',
        timeoutMs: 8000,
      });

      const raw = res.text?.trim() || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.customer_text && parsed.english_text) {
            const detectedCode = parsed.detected_source_language || 'en';
            return {
              translatedText: parsed.customer_text.trim(),
              englishText: parsed.english_text.trim(),
              detectedSourceLanguage: detectedCode,
              sourceLanguageName: getLanguageInfo(detectedCode).name,
              targetLanguage: targetLang,
              targetLanguageName: targetLangInfo.name,
              isTranslated: true,
            };
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[translateAgentReply] AI Provider failed, falling back to Google engine:', err);
    }
  }

  // 2. High-speed Google GTX translation engine
  // Step 2a: Generate English translation for dashboard
  let englishText = text;
  let detectedSourceLang = sourceLanguageCode || 'en';

  const enRes = isLikelyEnglishText(text)
    ? { translated: text, detectedLanguage: 'en' }
    : await translateWithGoogleGtx(text, 'en', sourceLanguageCode || 'auto');
  if (enRes) {
    englishText = enRes.translated;
    detectedSourceLang = enRes.detectedLanguage || 'en';
  } else {
    // Fallback: Check if Roman Urdu
    if (isRomanUrdu(text) || ROMAN_URDU_WORDS_REGEX.test(text)) {
      const urduScript = romanUrduToUrdu(text);
      const toEn = await translateViaFreeApi(urduScript, 'ur', 'en');
      if (toEn) englishText = toEn;
      detectedSourceLang = 'ur';
    }
  }

  // Step 2b: Translate to customer's target language
  let customerText = text;
  if (targetLang === 'en') {
    customerText = englishText;
  } else if (targetLang === detectedSourceLang && isLatinScript(text) === romanTarget) {
    // The agent already wrote in the customer's language and script.
    customerText = text;
  } else {
    // Pivot from englishText to customer's target language for maximum accuracy
    const targetRes = await translateWithGoogleGtx(englishText, targetLang, 'en', { romanize: romanTarget });
    if (targetRes?.translated) {
      customerText = targetRes.translated;
    } else {
      const direct = await translateViaFreeApi(text, detectedSourceLang, targetLang);
      if (direct) customerText = direct;
    }
  }

  const isActuallyTranslated =
    targetLang === 'en'
      ? englishText.trim().toLowerCase() !== text.trim().toLowerCase()
      : customerText.trim().toLowerCase() !== text.trim().toLowerCase();

  return {
    translatedText: customerText,
    englishText,
    detectedSourceLanguage: detectedSourceLang,
    sourceLanguageName: getLanguageInfo(detectedSourceLang).name,
    targetLanguage: targetLang,
    targetLanguageName: targetLangInfo.name,
    isTranslated: isActuallyTranslated,
  };
}

/**
 * Translates support agent English response into customer's native language.
 * (Maintained for backward-compatibility)
 */
export async function translateFromEnglish({
  englishText,
  targetLanguageCode,
  providerConfig,
  businessName,
}: {
  englishText: string;
  targetLanguageCode: string;
  providerConfig?: ProviderConfig | null;
  businessName?: string;
}): Promise<{ translatedText: string; targetLanguage: string; isTranslated: boolean }> {
  const res = await translateAgentReply({
    text: englishText,
    targetLanguageCode,
    providerConfig,
    businessName,
  });
  return {
    translatedText: res.translatedText,
    targetLanguage: res.targetLanguage,
    isTranslated: res.isTranslated,
  };
}

