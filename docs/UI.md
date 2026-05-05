# UI / UX Philosophy

This document defines the design and accessibility standards for freeBooks UI. All contributors should follow these guidelines.

---

## Typography

### Core rule: `rem` over everything

All font sizes use `rem` units. Never use `pt`, `px`, or `em` for font sizes.

`rem` is relative to the root `<html>` font size, which means it automatically respects:
- The user's browser font-size preference
- Browser zoom (`Ctrl +` / `Cmd +`)
- Operating-system accessibility settings (large text, etc.)

```css
:root {
  font-size: 100%; /* Fully respects browser/OS settings — do not override with px */
}

body {
  font-size: 1rem;   /* = 16px at browser default — never go below this for body text */
  line-height: 1.6;
}
```

### Fluid headings: `clamp()`

Use `clamp()` for headings and display text. This replaces media queries for most type scaling.

```css
/* Pattern: clamp(minimum, fluid-middle, maximum) */
/* - min/max must be rem (WCAG 1.4.4: supports 200% zoom) */
/* - fluid middle uses vw to scale with viewport */

h1 { font-size: clamp(1.375rem, 1.5vw + 1rem, 1.833rem); }
h2 { font-size: clamp(1.25rem,  1.25vw + 0.875rem, 1.667rem); }
```

- On small screens → uses the minimum (always readable)
- On a normal laptop → scales smoothly
- On a 4K / ultra-wide → caps at the maximum (never comically large)

### Reference scale (rem equivalents)

| Role | rem | ~px at 16px root |
|---|---|---|
| Body text | `1rem` | 16px |
| Page heading (h1) | `clamp(1.375rem, …, 1.833rem)` | 22–29px |
| Section heading (h2) | `clamp(1.25rem, …, 1.667rem)` | 20–27px |
| Sidebar company name | `1.125rem` | 18px |
| Sidebar nav items | `0.917rem` | ~15px |
| Top-bar nav links | `0.875rem` | 14px |
| Top-bar action buttons | `0.875rem` | 14px |
| Sub-labels / captions | `0.833rem` | ~13px |
| Small labels (uppercase) | `0.75rem` | 12px |
| Decorative carets | `0.625rem` | 10px |

### Rules
1. **Minimum body text:** `1rem` (16px). Never set paragraph or label text below this.
2. **`rem` for clamp bounds:** The min and max values in `clamp()` must be `rem`, not `vw` or `px`. The `vw` component belongs only in the fluid middle expression.
3. **Max ≤ 2.5× min:** Keep max/min ratio under 2.5× on body text (WCAG 1.4.4 — 200% zoom support).
4. **No `pt` or fixed `px` for font sizes.** `px` is acceptable for borders, spacing, and fixed-dimension elements (icon buttons, dividers, etc.).

---

## Spacing & Layout

- Use `px` or relative units for padding, margins, borders — not `rem` (spacing doesn't need to track user font preferences).
- Top bar height is fixed at `52px` — intentional, it's structural chrome.
- Page content max-width: `1100px`.

---

## Colours & Theming

All colours use CSS custom properties (`var(--name)`). Never hardcode colour values outside `:root` / `[data-theme="dark"]` blocks.

Light and dark themes are both defined. Any new UI element must work in both.

---

## Accessibility

- Contrast: ensure text meets WCAG AA (4.5:1 for body, 3:1 for large text).
- Interactive elements must have `:hover` and `:focus` states.
- Disabled / placeholder elements use `opacity: .4` or `cursor: not-allowed` — do not remove them from the DOM.
- Icon-only buttons carry a `title` attribute for screen readers.
