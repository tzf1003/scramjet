# Loading page visual check

Date: 2026-10-22

final result: passed

## Comparison evidence

- Source visual: `/Volumes/1T/scramjet/build/loading-page-preview/reference.html`, selected “进度呼吸” section.
- Implementation: `packages/demo/index.html` and `packages/demo/src/style.css`, served with application scripts suspended to hold the initial loading state.
- Full-view desktop comparison: `/Volumes/1T/scramjet/build/loading-page-preview/comparison-desktop.png`.
- Full-view narrow comparison: `/Volumes/1T/scramjet/build/loading-page-preview/comparison-mobile.png`.
- Browser viewport: 1280 × 720 CSS px; captured images: 1280 × 720 px. Both source and implementation use 600 × 540 CSS px desktop frames and 320 × 568 CSS px narrow frames. Effective screenshot density: 1 pixel per CSS pixel.
- Source normalized to its white content area, filling the same viewport as the implementation. Both use the light theme and initial loading state.
- The text, progress track and dots are legible at the captured scale; separate detail crops were unnecessary.

## Findings

No actionable P0, P1 or P2 differences in the first visual comparison.

- Typography: system sans-serif, 19 px / 500 title and 13 px supporting copy match the target.
- Layout: content centered horizontally at 42% of viewport height; 240 × 5 px progress track, 22 px spacing and three 4 px dots match. Both tested widths fit.
- Colors: white surface, charcoal title, blue `#5b6fe5` accent and `#e7ebff` track match. Supporting text uses `#677388` to improve readability.
- Assets: the selected design consists of native loading indicators and text.
- Copy: “正在准备网页” and “正在加载网页内容，请稍候” describe the startup state. Indeterminate motion communicates activity.
- Motion: the sweep and pulse render; the reduced-motion CSS produces a steady top line, centered track segment and static dots. The preview applies that CSS directly; the OS preference was not changed.
- Accessibility: status announcement is semantic; decorative indicators are hidden from assistive technology.

## Validation and coverage

- Demo production build passed using the existing external build directory.
- Browser console warning/error log was empty during the comparison.
- CSS is linked in the HTML head so the loading layout is available before application initialization.
- Existing iframe replacement and error handling retain their behavior. This check covers startup presentation; proxy navigation was not exercised end to end.
- Preview server and screenshots reside in `/Volumes/1T/scramjet/build/loading-page-preview/`.
