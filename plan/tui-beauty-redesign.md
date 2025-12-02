# TUI Beauty Redesign Plan

## Overview

Comprehensive visual overhaul of the Composer TUI to create a more polished, delightful terminal experience. No emoji - Unicode glyphs and ASCII only.

---

## Phase 1: Foundation (Color Palette & Theme)

### 1.1 Update Theme Colors
**File:** `src/theme/theme.ts`

Update the dark theme palette:
```
accent:        #7dd3fc  (sky blue)
accentWarm:    #fbbf24  (amber)
brand:         #c084fc  (violet)
success:       #86efac  (soft green)
error:         #fca5a5  (soft red)
warning:       #fde047  (soft yellow)
info:          #93c5fd  (soft blue)
cardBg:        #1e293b  (slate-800)
codeBg:        #0f172a  (slate-900)
textPrimary:   #f8fafc  (slate-50)
textSecondary: #94a3b8  (slate-400)
textMuted:     #64748b  (slate-500)
```

### 1.2 Add New Theme Colors
Add to ThemeColor type and schema:
- `cardBg`, `codeBg`, `inputBg` (background surfaces)
- `info` (semantic color)
- `textPrimary`, `textSecondary`, `textMuted` (text hierarchy)

---

## Phase 2: Tool Cards Redesign

### 2.1 Tool Status Badges
**File:** `src/tui/tool-execution.ts`

Add status tracking and badge rendering:
- `[done]` - success (green)
- `[run]` - running (amber)
- `[err]` - error (red)
- `[wait]` - awaiting approval (yellow)

### 2.2 Tool Icons
**File:** `src/tui/tool-renderers/*.ts`

Replace current icons with Unicode glyphs:
- `*` bash
- `~` edit
- `>` read
- `+` write
- `?` task
- `@` glob
- `#` grep

### 2.3 Tool Card Layout
**File:** `src/tui/tool-execution.ts`

- Square corners (not rounded) for tool cards
- Status badge in top-right of border
- Dashed separator between command and output: `├ ─ ─ ─ ─ ┤`

### 2.4 Border Flash Microinteraction
**File:** `src/tui/tool-execution.ts`

- Track completion state
- On success: flash border green for 400ms
- On error: flash border red for 400ms
- Requires timer and re-render trigger

---

## Phase 3: Message Cards Redesign

### 3.1 User Message Styling
**File:** `src/tui/user-message.ts`

- Right-align user messages (chat bubble style)
- Keep rounded corners
- Compact timestamp format

### 3.2 Assistant Message Styling
**File:** `src/tui/assistant-message.ts`

- Full-width with breathing room
- Brand glyph in header: `* COMPOSER`
- Nested code blocks with subtle borders

### 3.3 Thinking Block Styling
**File:** `src/tui/assistant-message.ts`

Replace lightning emoji with dashed header:
```
-- thinking -----------------------------------------------
  content here
-----------------------------------------------------------
```

---

## Phase 4: Loading & Progress States

### 4.1 Spinner Variants
**File:** `packages/tui/src/components/loader.ts`

Add new spinner options:
- braille: `['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']`
- dots: `['·  ', '·· ', '···', ' ··', '  ·', '   ']`
- pulse: `['◆', '◇', '◇', '◇']`

### 4.2 Typing Indicator
**File:** `src/tui/streaming-view.ts` or new component

Add typing indicator when assistant is generating:
```
* composer ···
```
With dot wave animation (400ms cycle)

### 4.3 Progress Bar Styling
**File:** `packages/tui/src/components/loader.ts`

Smoother progress bar with `━` filled and `─` empty

---

## Phase 5: Footer Redesign

### 5.1 Footer Layout
**File:** `src/tui/utils/footer-utils.ts`

New 2-line layout with horizontal rules:
```
──────────────────────────────────────────────────────────────
  * composer                                  claude-4-sonnet
──────────────────────────────────────────────────────────────
  ~/project (main)       +1.2k  -500  ~3.2k  |  ctx 2.3%  |  $0.04
```

### 5.2 Metric Grouping
Group metrics with pipe separators:
- Path and branch (left)
- Token stats (middle)
- Context % (middle)
- Cost (right)

---

## Phase 6: Input Editor Styling

### 6.1 Editor Border
**File:** `packages/tui/src/components/editor.ts`

- Title in top border: `╭─ Message ─────────╮`
- Keyboard hints in bottom border: `╰─── Tab: commands · @: files ───╯`
- More vertical padding

### 6.2 Cursor Indicator
Add vertical bar cursor indicator style option

---

## Phase 7: Modal & Selector Styling

### 7.1 Select List Styling
**File:** `packages/tui/src/components/select-list.ts`

- Radio button style: `●` selected, `○` unselected
- Description on second line (indented)
- Footer with keyboard hints

### 7.2 Modal Borders
**File:** `src/tui/utils/borders.ts`

Add double-line border option for urgent modals (approvals)

---

## Phase 8: Approval Prompts

### 8.1 Approval Modal Redesign
**File:** `src/tui/approval/` (relevant files)

- Double-line border for urgency
- Clear action description
- Explanation of consequences
- All options visible in footer

---

## Phase 9: Diff Visualization

### 9.1 Diff Rendering
**File:** `src/tui/tool-renderers/render-edit.ts`

- Line numbers with separator column
- Side markers for changed lines
- Summary bar: `+N added  -N removed`

---

## Phase 10: Special Modes

### 10.1 Zen Mode
**File:** `src/tui/tui-renderer.ts`

- Centered dot separators between messages: `·  ·  ·`
- No borders at all
- Maximum breathing room

### 10.2 Welcome Screen
**File:** New `src/tui/welcome-view.ts`

- Centered brand card with `*  c o m p o s e r`
- Model status line
- Quick start tips
- Fades after first message

---

## Implementation Order

| Priority | Task | Files | Est. Complexity |
|----------|------|-------|-----------------|
| 1 | Color palette update | theme.ts | Low |
| 2 | Tool status badges | tool-execution.ts | Low |
| 3 | Tool icons | tool-renderers/*.ts | Low |
| 4 | Tool card layout (square corners, dashed sep) | tool-execution.ts, borders.ts | Medium |
| 5 | Thinking block styling | assistant-message.ts | Low |
| 6 | Spinner variants | loader.ts | Low |
| 7 | Footer redesign | footer-utils.ts | Medium |
| 8 | Diff visualization | render-edit.ts | Medium |
| 9 | Approval prompt redesign | approval/*.ts | Medium |
| 10 | Select list styling | select-list.ts | Medium |
| 11 | User message right-align | user-message.ts | Medium |
| 12 | Editor styling | editor.ts | Medium |
| 13 | Border flash microinteraction | tool-execution.ts | Medium |
| 14 | Typing indicator | streaming-view.ts | Medium |
| 15 | Zen mode enhancements | tui-renderer.ts | Low |
| 16 | Welcome screen | welcome-view.ts (new) | Medium |

---

## Testing Checklist

- [ ] All themes still load correctly
- [ ] Tool cards render with new styling
- [ ] Status badges update correctly (running -> done/error)
- [ ] Border flash animations work
- [ ] Footer displays correctly at various widths
- [ ] Diffs render with line numbers
- [ ] Approval prompts are clear and actionable
- [ ] Modals have consistent styling
- [ ] Zen mode removes all borders
- [ ] SSH/low-bandwidth mode degrades gracefully
- [ ] No emoji anywhere in output

---

## Notes

- All Unicode glyphs must have ASCII fallbacks for `lowUnicode` mode
- Animations should be skippable in low-bandwidth/SSH mode
- Color changes should work in both truecolor and 256-color modes
- Test on dark and light terminal backgrounds
