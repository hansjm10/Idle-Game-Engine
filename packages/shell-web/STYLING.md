# Shell-Web Styling Guide

## Overview

The `@idle-engine/shell-web` package uses **CSS Modules** for component styling. This approach provides scoped styles, better maintainability, and improved build optimization compared to inline styles.

## Why CSS Modules?

### Benefits

1. **Scoped Styles**: Class names are automatically scoped to prevent global namespace pollution
2. **Type Safety**: TypeScript can provide autocomplete for CSS class names (when using TypeScript CSS Module declarations)
3. **Performance**: Styles are extracted to separate CSS files that can be cached by the browser
4. **Maintainability**: Colors and styles are centralized in CSS files rather than scattered in JSX
5. **Build Optimization**: CSS can be minified, tree-shaken, and optimized by build tools
6. **Theming**: Easier to implement theming or dark mode in the future

### Migration from Inline Styles

This project previously used inline styles with hardcoded values. All persistence-related components have been migrated to CSS Modules to improve maintainability.

## File Structure

Each component that needs styling has a corresponding `.module.css` file:

```
src/
├── modules/
│   ├── PersistencePanel.tsx
│   ├── PersistencePanel.module.css
│   ├── ErrorBoundary.tsx
│   ├── ErrorBoundary.module.css
│   ├── App.tsx
│   └── App.module.css
├── main.tsx
└── main.module.css
```

## Usage Pattern

### Importing CSS Modules

```typescript
import styles from './ComponentName.module.css';
```

### Using Classes

```tsx
<div className={styles.className}>
  Content
</div>
```

### Combining Multiple Classes

```tsx
<div className={`${styles.baseClass} ${styles.modifierClass}`}>
  Content
</div>
```

### Conditional Classes

```tsx
const toastClass =
  type === 'error' ? styles.toastError :
  type === 'success' ? styles.toastSuccess :
  styles.toastInfo;

<div className={`${styles.toast} ${toastClass}`}>
  Toast content
</div>
```

## Color Palette

The persistence UI components use a consistent error-focused color palette:

### Error/Alert Colors
- **Light Red Background**: `#fef2f2` - Used for error alert backgrounds
- **Medium Red Border**: `#dc2626` - Used for error borders and primary error buttons
- **Dark Red Text**: `#991b1b` - Used for error headings and important text
- **Brown-Red Warning**: `#7c2d12` - Used for warning text

### Success Colors
- **Light Green Background**: `#efe` - Used for success toast backgrounds
- **Medium Green Border**: `#3c3` - Used for success borders
- **Dark Green Text**: `#059669` - Used for active/success status indicators

### Info Colors
- **Light Blue Background**: `#eef` - Used for info toast backgrounds
- **Medium Blue Border**: `#33c` - Used for info borders
- **Medium Blue Text**: `#2563eb` - Used for in-progress indicators

### Neutral Colors
- **Gray Text**: `#666` - Used for secondary text and metadata
- **Medium Gray**: `#6b7280` - Used for inactive status
- **Border Gray**: `#ccc` - Used for panel borders

## Component Styling Examples

### PersistencePanel

The `PersistencePanel` component demonstrates:
- Panel container with border and padding
- Toast notifications with type-based styling (success, error, info)
- Dynamic `aria-live` based on toast types for accessibility
- Autosave status indicators with color-coded states
- CSS animations (pulse effect for saving indicator)

**Key Features:**
```css
/* Animation defined in CSS */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.autosaveIndicator {
  animation: pulse 1.5s ease-in-out infinite;
}
```

### ErrorBoundary

The `ErrorBoundary` component provides:
- Default error alert styling with red error theme
- Button styles with hover and focus states
- Reusable error UI classes that can be imported by other components

**Reusability Pattern:**
```typescript
// App.tsx imports ErrorBoundary styles for its custom fallback
import errorStyles from './ErrorBoundary.module.css';
import appStyles from './App.module.css';

// Reuses error styles, adds app-specific styles
<div className={errorStyles.errorAlert}>
  <h3 className={errorStyles.errorHeading}>Error Title</h3>
  <p className={appStyles.customStyle}>Custom content</p>
</div>
```

### Main Entry Point

The `main.tsx` uses a full-screen centered error layout for critical failures:
- Flexbox centering for full viewport height
- Card-based container design
- High visibility error styling

## Accessibility Considerations

CSS Modules work seamlessly with accessibility features:

1. **Dynamic ARIA Attributes**: Combine CSS classes with dynamic `aria-live` values:
   ```tsx
   <div
     aria-live={hasErrorToast ? 'assertive' : 'polite'}
     className={styles.toastContainer}
   >
   ```

2. **Focus Styles**: All interactive elements have `:focus-visible` styles defined in CSS:
   ```css
   .button:focus-visible {
     outline: 2px solid #dc2626;
     outline-offset: 2px;
   }
   ```

3. **Color Contrast**: All color combinations meet WCAG 2.1 AA standards for contrast

## Best Practices

### DO:
- ✅ Create a `.module.css` file for each component with significant styling
- ✅ Use semantic class names that describe purpose (e.g., `errorAlert`, `toastContainer`)
- ✅ Document color usage in CSS file headers
- ✅ Define animations in CSS rather than JS
- ✅ Reuse styles across components by importing CSS modules
- ✅ Add `:hover` and `:focus-visible` states for interactive elements

### DON'T:
- ❌ Use inline styles for anything other than truly dynamic values
- ❌ Hardcode color values in JSX
- ❌ Create overly specific class names (avoid deep nesting like `.panel .section .item .text`)
- ❌ Use `!important` - specificity should be managed through CSS structure
- ❌ Duplicate color values - define them once and reference the class

## Future Enhancements

Potential improvements to the styling system:

1. **CSS Variables**: Migrate hardcoded colors to CSS custom properties for theming
   ```css
   :root {
     --color-error-bg: #fef2f2;
     --color-error-border: #dc2626;
     --color-error-text: #991b1b;
   }
   ```

2. **Dark Mode**: Use CSS variables and `prefers-color-scheme` media query

3. **Shared Design Tokens**: Create a central `tokens.module.css` for common values

4. **TypeScript Declarations**: Generate `.d.ts` files for CSS modules to enable autocomplete

## Testing

CSS Modules work transparently with testing libraries:

```typescript
import { render, screen } from '@testing-library/react';
import { PersistencePanel } from './PersistencePanel';

// CSS classes are automatically applied, no special testing needed
render(<PersistencePanel {...props} />);
expect(screen.getByRole('alert')).toBeInTheDocument();
```

The actual class names are transformed during build (e.g., `errorAlert` → `ErrorBoundary_errorAlert_a3x9f`), but this is transparent to tests.

## Migration Checklist

When converting a component from inline styles to CSS Modules:

- [ ] Create `ComponentName.module.css` file
- [ ] Add comprehensive header comment documenting purpose and colors
- [ ] Extract all inline styles to CSS classes
- [ ] Import CSS module in component: `import styles from './ComponentName.module.css'`
- [ ] Replace `style={{}}` with `className={styles.className}`
- [ ] Add `:hover` and `:focus-visible` states for interactive elements
- [ ] Test component renders correctly
- [ ] Test that all interactive states work (hover, focus, active)
- [ ] Verify accessibility features still function

## References

- [CSS Modules Documentation](https://github.com/css-modules/css-modules)
- [Vite CSS Modules](https://vitejs.dev/guide/features.html#css-modules)
- [WCAG 2.1 Color Contrast Guidelines](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
