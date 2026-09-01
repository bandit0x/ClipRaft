# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Tauri v2, Rust, React 19, TypeScript, and SQLite for a Windows 10 22H2 / Windows 11 x64 desktop application.

## Users

Single users working across Windows desktop applications who repeatedly copy text, images, and files and need to recover or reuse more than the system clipboard's current item without interrupting their active task.

## Product Purpose

ClipRaft is a local-first, multi-slot, multimodal clipboard workspace. It captures one visible card per copy action, preserves the useful source representations, and lets the user search, pin, drag, copy, or paste previous content from a side-docked panel.

Success means copying remains effortless and uninterrupted, recent material is immediately recoverable, and reusing a card feels faster than returning to its source application.

## Positioning

Unlike a conventional history window opened after the fact, ClipRaft lives as a quiet edge handle and acknowledges each copy with a non-focus-stealing peek. Its card stream makes clipboard history feel spatial and manipulable without becoming a document manager.

## Operating Context

- The app runs in the Windows tray and docks to the left or right edge of a single display.
- A copy action produces a two-second peek; explicit hover, click, or `Win+Alt+V` opens the full panel.
- Users browse a newest-first card stream, search or filter it, and restore content by keyboard, click, or drag.
- The panel must never steal focus during automatic clipboard feedback.
- History persistence is optional; when disabled, content lasts only for the running session.

## Capabilities and Constraints

- One copy action creates one card with a primary text, image, or file modality and may retain multiple original clipboard representations.
- Repeated content reuses the existing unpinned card and moves it to the top.
- Files remain path references unless the user explicitly chooses to keep a copy.
- Dragging into the panel creates a card; dragging out restores the appropriate OS payload; dragging to the trash area soft-deletes with undo.
- The default history limit is 200 unpinned cards or 30 days, with a 1GB managed-asset budget.
- Search covers text and file names through SQLite FTS5; OCR, AI classification, cloud sync, accounts, plugins, boards, multiple displays, and automatic updates are outside the MVP.
- The app does not collect telemetry or send clipboard content over the network.
- Clipboard sources that explicitly opt out of monitoring or history are respected without exposing a separate privacy-management feature.
- UI is Simplified Chinese in the MVP, with centralized copy for later localization.
- Distribution begins as a private local prototype, then a portable build and installer; no Microsoft Store release in the MVP.

## Brand Commitments

- Product name: ClipRaft.
- The product must feel technological and forward-looking without becoming a noisy science-fiction HUD.
- The entire vertical bar is a narrow sunlit summer creek, roughly half the width of a conventional 380px clipboard sidebar; it is not an opaque panel decorated with water texture.
- Clipboard cards are small wooden rafts floating on that creek, with real visual thickness and naturally varied silhouettes rather than recolored rectangular UI cards.
- The bottom control dock occupies about half the creek's width and remains visibly detached from the last raft.
- Floating and transitions are gentle, premium, and purposeful; bounce, harsh flashes, constant shimmer, and visual clutter are unacceptable.
- The selected visual direction is `.impeccable/mocks/creek-c-meander.png`: a realistic sunlit creek with sparse stone and foliage accents, broad open water, small thick wooden rafts, and modality-specific parchment, photo, and file surfaces. Material visual corrections require renewed approval before implementation.
- When a card is deleted, replaced, or deduplicated, rafts below its former slot drift upstream into place along a shallow curved path. The movement preserves spatial continuity, uses no bounce, and has an intentional reduced-motion alternative.

## Evidence on Hand

- Code-level comparative research: `docs/research/clipboard-managers.md`.
- Domain vocabulary: `CONTEXT.md`.
- Architecture decisions: `docs/adr/0001-tauri-and-selective-open-source-reuse.md` and `docs/adr/0002-edge-panel-state-and-focus-contract.md`.
- No logo, type license, production screenshots, or other brand assets currently exist; future work must not fabricate evidence or commercial claims.

## Product Principles

- Acknowledge copying without interrupting it.
- Preserve source fidelity behind one clear card.
- Make the common paste path immediate and keyboard-friendly.
- Keep history local, bounded, and recoverable.
- Spend visual expression on spatial character and feedback, not on extra product complexity.

## Accessibility & Inclusion

The MVP supports full keyboard operation, readable contrast, Windows DPI scaling, and the system reduced-motion preference. Motion may enrich state changes but cannot be required to understand state or complete an action.
