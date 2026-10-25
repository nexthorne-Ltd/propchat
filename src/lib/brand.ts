/**
 * The colour a workspace gets before it picks its own `brand_color`. It used
 * to be written out in each place that needed it, as three different blues,
 * so the settings preview, the widget and the emails disagreed for any
 * workspace that never chose a colour. The widget's own default wins, since
 * that is what visitors actually see. Client-safe (the widget imports it too).
 */
export const DEFAULT_BRAND_COLOR = '#2e5bff';
