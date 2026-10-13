# Curated desktop visual system

Factory uses one global semantic token system and three locally bundled public-domain paintings
for its desktop identity. Users may persist only a validated Factory-owned background key in
PostgreSQL; navigation and window state stay in the browser. This keeps authentication and every
product app visually coherent without adding a generic theme engine, unsafe external images, or
a desktop window manager. Vesence informs the composition, restraint, glass treatment, and motion,
but Factory uses its own identity, open fonts, and licensed assets.

Each bundled painting selects a fixed, contrast-tested accent and restrained surface tint. Derived
focus/selection colors use that same palette; success, warning and failure colors keep their meaning.
Sansita remains the display face and Inter the interface/document face. There is no image sampling
service or theme dependency for three known paintings.

Factory document windows have one subtly translucent blurred base. Nested editors stay transparent
instead of stacking near-opaque sheets. Navigation is lighter glass, menus are opaque enough to read,
and native IDE, Terminal and Preview bodies remain opaque. Reduced transparency and unsupported
backdrop filtering use solid surfaces. Motion follows the operating-system preference.

Minimize removes interaction immediately, then hides the retained window after a short opacity/position
exit. Reopening cancels that hide; it does not stop runtime work. Controls share geometry and insets.
Dock activation and instance selection are separately accessible buttons inside one visual control.
Frequent secondary and primary actions stay adjacent in source order; overflow follows at the far right.
History and rare management actions belong in a compact action menu. Relationship actions open one
searchable picker at a time, never embedded native selects in the root menu. Focus returns to the
persistent opener. Document frost must transmit the actual dimmed Board visibly; rendered-pixel
regressions and contrast checks supplement real screenshots rather than relying on alpha tokens alone.
