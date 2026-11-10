# React

## Components

- Declared as top-level `function` declarations, named export, one component
  per file.
- Props typed with an `interface` (e.g. `interface UserCardProps`).
- Extract a component only when it owns state, effects or behaviour. A child
  that just takes a slice of the parent's JSX plus threaded props (`isBusy`,
  `isSavePending`, `onCancel`, `onConfirm` for a button row) adds a prop
  boundary and nothing else — keep that JSX inline.
- When handlers (mutations, error mapping, confirm dialogs) crowd a component
  body, move them into a `use<Subject>Actions` hook that returns the handlers
  and pending flags; the component keeps the fields and the layout.

## Hooks

- Custom hooks named `use*`, one per file, kebab-case filename.
- General-purpose hooks (`useDebounce`, `useResizeObserver`, `useMediaQuery`,
  `useControllableState`…) are never added as a dependency, not even a good
  one. Compare implementations across libraries per hook (latest callback
  without resubscribing, no needless re-renders, cleanup, React 19 /
  Compiler-safe) and copy the best one:
  - `vendir.yml` pins the upstream file; `vendir sync` writes the untouched
    original to `vendor/upstream/` (outside `src`, excluded from tsc/Biome);
  - the working copy lives in `src/shared/hooks/vendor/` and differs from
    the original only in imports; a copy with a behaviour fix moves to
    `src/shared/hooks/` and the deviation is recorded;
  - upstream update: `vendir sync`, then
    `git merge-file <working copy> <upstream before> <upstream after>`,
    resolve conflicts, run the hook tests;
  - no implementation fits → own hook with a test (React 19 `useEffectEvent`
    for the latest callback).
- Features import hooks only from `@/shared/hooks`.

## Styling

- Tailwind classes are auto-sorted by Biome inside `cn` / `clsx` / `cva` /
  `tw` — don't fight the order.
- Colours come from theme tokens (`bg-chart-1`, `text-destructive`), never a
  raw value (`bg-[#2a78d6]`).

## Accessibility

- Every interactive element is keyboard-operable and focusable.
