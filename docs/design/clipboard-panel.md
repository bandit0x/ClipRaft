# Clipboard Panel Visual and Motion Specification

Status: approved on 2026-09-02; implementation in progress.

## Approved reference

The approved reference is `.impeccable/mocks/creek-c-meander.png`. It defines the visual world, not a literal full-desktop wallpaper. The production window occupies only the docked creek strip and must remain convincing over an arbitrary desktop background.

## Composition

- The expanded panel is a narrow, transparent-edged summer creek, targeting 190–210 logical pixels before Windows DPI scaling.
- A few rounded stones, sparse foliage accents, shallow turquoise water, and sunlight establish the banks. Water and working content dominate; continuous pebble borders, dense grass, floral scatter, and garden-like decoration are excluded.
- Clipboard items are medium-small, thick wooden rafts floating inside the creek. They remain clearly readable at 125% Windows scaling while preserving generous water between items. Their silhouette may vary, while their interaction bounds and alignment remain predictable.
- Text cards carry a parchment sheet; image cards carry a framed preview; file cards carry a folder or document plaque. Type is readable Simplified Chinese rather than decorative lettering.
- The title and search affordance live in separate, slightly irregular wooden cabins near the upstream edge. They are seen strictly from above: roof planes, a horizontal ridge, chimney or skylight, and a downstream cast shadow establish the form without visible walls or supports.
- Search, pin/filter, and settings sit as roof-hatch-like controls on a compact top-down wooden cabin at the bottom. The cabin is about half the creek width and never touches the final raft.

## Motion thesis

The focal motion is river continuity: when a raft disappears or changes position, the stream carries the remaining rafts into their new places. Motion explains ordering and replacement; it is not ambient spectacle.

### Delete and replacement

1. The affected raft acknowledges the action in 120–160 ms. A deleted raft drifts slightly toward the downstream bank while fading; a deduplicated raft lifts from the water and travels toward the newest slot.
2. Rafts below the vacated slot move upstream along a shallow curved path. Use FLIP-style transforms so document layout is committed immediately while pixels preserve their previous position.
3. Upstream travel lasts 420–560 ms according to distance, with `cubic-bezier(0.16, 1, 0.3, 1)`. Adjacent rafts start 24–36 ms apart, capped at 120 ms total stagger.
4. Each raft may sway laterally by 4–8 px and rotate no more than 0.8 degrees before settling. There is no bounce, spring overshoot, or elastic snap.
5. Each visible raft maintains a restrained hull ring, side foam, and downstream wake. The raft itself rises, falls, and rolls by only a few pixels/degrees; continuous animation stops while the panel is hidden.

Repeated copy or delete actions retarget from the current visual position instead of queuing animations. Pinned items retain their ordering contract. A five-second undo reverses the spatial transition from the current state without replaying the entire sequence.

## Reduced motion and performance

- With Windows reduced-motion enabled, replace upstream travel with a 120–160 ms opacity transition and at most 4 px of displacement; ordering and deletion feedback remain legible.
- Animate transforms and opacity only for raft movement. Do not animate `top`, `left`, width, height, or margins.
- Shadows, ripples, and filters stay bounded to the creek window. `will-change` is applied only while motion is active.
- The acceptance target is smooth interaction at 60 Hz on the supported Windows 10 22H2 baseline, including a full 200-card history where only visible and overscan rafts animate.

## Acceptance boundaries

- The interface must read first as a clipboard utility and second as a landscape illustration.
- A card remains selectable, draggable, and keyboard-operable regardless of its decorative silhouette.
- No motion is required to understand state, and the panel never steals focus during automatic copy feedback.
- The approved reference is the fidelity target for material, depth, spacing, and atmosphere; desktop icons, wallpaper, date, and taskbar shown in it are not product assets.
