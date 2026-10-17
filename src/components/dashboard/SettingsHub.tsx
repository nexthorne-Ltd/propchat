// The Settings area moved to components/settings. This keeps the old import
// path (and section ids such as 'widget', 'team', 'channels') working.
export { SettingsHub, settingsSections } from '@/components/settings/SettingsHub';
export type { SettingsHubProps } from '@/components/settings/SettingsHub';
/** "section", "section:tab" or an older section id; see lib/settings/registry. */
export type SectionId = string;
