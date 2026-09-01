# Use Tauri and selectively reuse permissive clipboard code

ClipRaft will use Tauri v2, Rust, React 19, TypeScript, and SQLite so the Windows-resident app can reuse EcoPaste's Apache-2.0 clipboard, storage, and drag-out modules without carrying an Electron runtime. Ditto and PasteBar remain architecture and interaction references only: their GPL-3.0 and custom non-commercial code will not be copied unless the product's licensing strategy is deliberately changed later.
