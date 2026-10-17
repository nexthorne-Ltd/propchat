# Zentry design system

The rules for how Zentry looks and behaves. If a screen needs something this
file doesn't cover, add it here (and to the shared components) instead of
styling it inline.

**Direction:** clean, flat, modern SaaS (the bar is Zendesk, Intercom and
Linear). High contrast, generous spacing, **one accent colour**. Glass is
allowed in exactly three places: the app sidebar, modals/popovers, and the
customer chat widget. Everything else is flat. No neumorphism, claymorphism,
skeuomorphism, decorative gradients or hover lifts.

Where things live:

| What | File |
|---|---|
| Tokens (CSS variables) + component classes | `src/app/globals.css` |
| Tailwind bridge (`bg-surface`, `text-ink-2`, `text-ui`…) | `@theme inline` block in `globals.css` |
| Shared React components | `src/components/ui/` |
| Contrast maths + token tests | `src/lib/design/contrast.ts`, `src/lib/design/tokens.test.ts` |
| Command palette ranking (+ tests) | `src/lib/command-palette.ts` |
| Widget tokens (Shadow DOM, can't see the app's CSS) | `:host` block in `widget/src/index.ts` |
| Screenshot harness (mock Supabase) | `scripts/design/` |

---

## 1. Tokens

All colours are CSS variables named `--ds-*`, exposed to Tailwind as colour
utilities. Dark mode swaps the variables (`data-theme="dark"` on `<html>`, or
the OS setting when nothing is stored), so **never write `dark:` colour
classes and never use Tailwind's palette (`text-gray-500`, `bg-blue-600`) or
hex values in components.** The token tests fail if a text/background pair
drops below WCAG AA (4.5:1) or the two dark blocks drift apart.

### Colour

| Token (Tailwind name) | Use |
|---|---|
| `canvas`, `canvas-alt` | Page background; alternating bands on marketing pages |
| `surface` | Cards, panels, table rows, inputs |
| `surface-2` | Inset areas, table headers, secondary panels |
| `surface-3` | Hover fill, tracks, neutral chips |
| `overlay` | Backdrop behind modals and drawers |
| `ink` | Primary text, headings |
| `ink-2` | Secondary text, labels |
| `ink-3` | Meta text, placeholders, icons at rest (still AA on every surface) |
| `line`, `line-2`, `line-3` | Hairlines → input borders → hover borders |
| `accent` (+ `-hover`, `-ink`, `-soft`, `-line`) | **The** accent: primary buttons, links, focus, selection, active nav |
| `primary` (+ `-hover`, `-ink`) | Alias of accent, kept so a brand can split them later |
| `success`, `warn`, `danger`, `info` (+ `-soft`, `-line`) | Status only. The base colour is readable as text on its `-soft` fill |
| `invert` (+ `-2`, `-ink`, `-ink-2`) | Surfaces that stay dark in both themes: tooltips, code blocks, the auth panel |
| `bubble-out` (+ `-ink`) | Agent's outgoing chat bubble |

Opacity modifiers on tokens are fine for tints (`bg-accent/10`), but prefer
the `-soft` token when one exists.

Workspace brand colours (`workspaces.brand_color`) are customer content.
They style the widget and help center for that workspace and never replace
`accent` in the agent app.

### Typography

Geist Sans for UI and Geist Mono for code and IDs. One scale. **Never use
`text-[13px]`-style arbitrary sizes.**

| Class | Size / line height | Use |
|---|---|---|
| `text-2xs` | 11 / 16 | Badges, eyebrows, table headers, timestamps |
| `text-xs` | 12 / 16 | Meta lines, hints, dense lists |
| `text-ui` | 13 / 20 | **Default UI text**: buttons, nav, list rows, inputs on desktop |
| `text-sm` | 14 / 20 | Body copy in panels, form text |
| `text-md` | 15 / 24 | Modal titles, section headers, chat messages |
| `text-base` | 16 / 24 | Long-form reading (articles), mobile inputs (stops iOS zoom) |
| `text-lg` … `text-5xl` | Tailwind defaults | Page titles and marketing headings |

Weights: 400 body, 500 UI labels, 600 headings and buttons, 700 only for
numbers in KPI cards. Headings get tight tracking from the base layer.
`.eyebrow` is the uppercase section label.

### Spacing

Tailwind's 4px scale. Use the steps below so screens share a rhythm:

- **2–4 (8–16px):** inside controls and between related items.
- **5–6 (20–24px):** card padding, gaps between form fields, page gutters on mobile (16px minimum).
- **8 (32px):** page gutters on desktop, gaps between sections.
- Control heights: 26px `btn-xs`, 32px `btn-sm`, 36px `input-sm`/rows, 40px `btn`, 44px `input`. Touch targets on phones are at least 40px.

### Radius

`rounded-xs` 6px (kbd, tiny chips) · `rounded-sm` 8px (buttons-sm, inputs-sm,
menu items) · `rounded-md` 10px (buttons, inputs) · `rounded-lg` 14px (cards,
popovers) · `rounded-xl` 18px · `rounded-2xl` 24px (modals, widget window) ·
`rounded-full` (avatars, pills).

### Elevation

Flat first: separate things with `line` borders and surface steps, not
shadows. `shadow-xs` on cards and buttons, `shadow-md` on hover only where
something is draggable or clickable as a whole, `shadow-lg` on popovers and
toasts, `shadow-xl` on modals. No coloured or glowing shadows.

### Glass

`.glass` (sidebar, widget window) and `.popover` (menus, modals, drawers,
command palette) use `--ds-glass-bg` (94% opaque surface in light, 92% in dark), a hairline
`--ds-glass-border` and a 24px backdrop blur. The fill is opaque enough that
text contrast never depends on what is behind it. Don't add `backdrop-blur-*`
anywhere else; sticky headers are solid `bg-surface`.

### Motion

| Token | Duration | Use |
|---|---|---|
| `--ds-dur-fast` | 120ms | Hover, press, colour changes |
| `--ds-dur` | 180ms | Menus, tabs, tooltips, toasts |
| `--ds-dur-slow` | 280ms | Modals, drawers, theme swap |

Easing is `--ds-ease` (standard) or `--ds-ease-out` (entrances). Classes:
`animate-fade`, `animate-pop` (dialogs), `animate-drawer`, `animate-toast`,
`animate-rise` (marketing only). Motion explains a change; it never
decorates. `prefers-reduced-motion` turns all of it off globally.

### Layers

`--ds-z-sticky` 20 · `--ds-z-sidebar` 30 · `--ds-z-popover` 60 ·
`--ds-z-modal` 70 · `--ds-z-toast` 80 · `--ds-z-tooltip` 90.

---

## 2. Components

Import from `@/components/ui/*`. Each one is built on the CSS classes in
`globals.css`, so older markup that still writes `className="btn btn-primary"`
looks the same. New code uses the components.

| Component | File | Notes |
|---|---|---|
| `Button` | `Button.tsx` | `variant` primary / secondary / ghost / danger; `size` xs / sm / md / lg; `loading`; `iconOnly` (requires `aria-label`). One primary button per view. |
| `Input`, `Textarea`, `Select`, `Field` | `Input.tsx` | `Field` wires the label, hint and error to the control (`htmlFor`, `aria-describedby`, `aria-invalid`). `inputClass`/`selectClass` for third-party inputs. |
| `Modal`, `Drawer`, `useFocusTrap` | `Modal.tsx` | Portal, focus trap, Esc and backdrop close, focus restored on close. The modal becomes a bottom sheet under 640px. `title` is required (it labels the dialog). |
| `Table`, `SortHeader` | `Table.tsx` + `.table` | Scrolls sideways on narrow screens; sticky header; `aria-sort`. Rows that open something must be keyboard-reachable (see the ticket list: `tabIndex`, Enter/Space, ↑/↓). |
| `Tabs` | `Tabs.tsx` + `.tabs`/`.tab` | ARIA tabs with ←/→/Home/End. `variant="pill"` is the segmented control. |
| `Badge` | `Badge.tsx` + `.pill-*` | Tones neutral / accent / success / warn / danger / info. Always has text; colour is never the only signal. |
| `Avatar` | `Avatar.tsx` | Deterministic colour from a seed; `online` adds a presence dot. |
| `ToastProvider`, `useToast` | `Toast.tsx` | Errors stay until dismissed (`role="alert"`); others leave after 5s (`role="status"`). |
| `Tooltip` | `Tooltip.tsx` + `.tooltip` | Hover and focus, Esc closes, `aria-describedby`. Text only, never the only place information lives. |
| `EmptyState` | `EmptyState.tsx` | Presets for inbox, radar, tags, search; `type="custom"` with title/description/action otherwise. |
| `LoadingState`, `ErrorState`, `SkeletonBlock` | `States.tsx` | See §3. |
| Skeletons | `Skeleton.tsx`, `.skeleton` | Shaped like the content they replace. |
| `CommandPalette` | `CommandPalette.tsx` | Generic combobox palette; the dashboard wiring is `components/dashboard/DashboardCommandPalette.tsx`. |
| `Menu` | `Menu.tsx` | Portal dropdown/select on the glass `.popover` surface. |
| `Logo`, `BrandIcon`, `ChannelBadge`, `ThemeToggle`, `KeyboardShortcutsModal` | | Product-specific pieces. |

---

## 3. Usage rules

**Every screen has four states.** Before shipping a screen, check each one:

1. **Loading:** a skeleton in the shape of the content (list rows, cards). Use `LoadingState` only when the shape is unknown. Never show a blank panel.
2. **Empty:** `EmptyState` says what will appear here and offers the next step ("Create ticket", "Install the widget").
3. **Error:** `ErrorState` (whole panel) or an inline `role="alert"` banner (partial failure). Show the server's message and a **Try again** that actually refetches. Never swallow the error into `console.error` only.
4. **Populated**, including very long names, 0 and 10,000 counts, and RTL text in chat.

**Keyboard and focus.**
- Everything clickable is a `<button>` or `<a>`, or has `tabIndex={0}` with Enter/Space handling.
- Focus is always visible: the global `:focus-visible` rule draws a 2px accent outline. Don't remove outlines; inputs use their border plus `--ds-ring` instead.
- Dialogs trap focus and give it back on close (`Modal`, `Drawer`, `useFocusTrap`).
- Global shortcuts: **Ctrl/⌘ K** command palette, **/** search conversations, **?** shortcuts sheet, **j/k** or ↑/↓ to move through the inbox, **R** refresh, **Esc** close or deselect. Shortcuts ignore keys typed in inputs and keys with modifiers they don't own. A field that uses a combo itself (the article editor's Ctrl+K for links) calls `preventDefault()`, and the palette steps aside.

**Mobile (390px and up).**
- No horizontal page scroll. Tables scroll inside their own region; toolbars wrap or scroll.
- 16px minimum side gutters. Inputs are `text-base` on phones so iOS doesn't zoom.
- Fixed bottom bars respect `env(safe-area-inset-bottom)`. Modals become bottom sheets.

**Contrast (WCAG AA).**
- Body text ≥ 4.5:1, large text and UI parts ≥ 3:1. The token tests enforce this for every token pair; you only need to stay on tokens.
- `ink-3` is the lightest colour allowed for text. Don't fade text with `opacity-*` below 70%.
- Status colours (`text-success`, `text-warn`, `text-danger`) are AA on `surface` and on their own `-soft` fill.

**Colour discipline.**
- One accent. Primary actions, links, focus, selected nav, and the "you" side of chat. Use status colours only for status.
- Purple "AI" tints, gradients and per-feature colours are gone. AI features use the accent with a ✨ icon.
- Charts may use a categorical palette, but the first series is always `accent`.

**Writing.** Sentence case for labels and buttons ("New ticket", not "New Ticket"). Buttons say what happens ("Send reply"). Errors say what went wrong and what to do next.

---

## 4. Command palette

Ctrl+K (⌘K on macOS), or **Search… Ctrl K** in the sidebar, opens the
palette anywhere in the dashboard. It lists:

- **Tickets:** typing a number (`1003`, `#1003`), a subject, or a requester runs `searchTicketsAction` (the same search as the ticket list, so RLS and role rules apply). Results open in the ticket screen.
- **Navigate:** Inbox, Tickets, Live visitors, Analytics (admins), Help Desk, Settings.
- **Ticket views:** the system views plus the workspace's saved views.
- **Settings:** every settings section the agent's role can open, matched on its label, group and keywords ("smtp", "invite", "dns").
- **Actions:** the keyboard shortcuts sheet.

Ranking lives in `src/lib/command-palette.ts`. Results are grouped in a fixed
order, so sections don't jump around while you type. Title prefixes rank
above word starts, which rank above substrings, then keyword matches, then
in-order fuzzy matches. ↑/↓ move (wrapping), Enter opens, Esc closes. The
input is an ARIA combobox, so screen readers announce the highlighted result.

---

## 5. Screenshots and checking a change

`scripts/design/mock-supabase.mjs` is a tiny fake Supabase (Auth +
PostgREST) with fixture data, so every screen can be rendered without a real
project:

```bash
node scripts/design/mock-supabase.mjs &           # :54321
# .env.local: NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321, NEXT_PUBLIC_SUPABASE_ANON_KEY=mock,
#             HELP_BASE_DOMAIN=localhost, NEXT_PUBLIC_HELP_BASE_DOMAIN=localhost
set -a; . ./.env.local; set +a; npx next dev       # export the vars: the middleware reads process.env
node scripts/design/screenshots.mjs out/           # needs `playwright`; CHROMIUM_PATH to use a local Chromium
```

The script captures the login, signup, inbox, tickets, help desk, settings,
palette, help center and widget screens. It takes desktop shots in light and
dark mode and phone-width (390px) shots in light mode. Before/after captures
from the design-system PR are in `docs/design/screenshots/`.
