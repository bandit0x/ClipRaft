# Keep edge-panel state separate from clipboard capture

The window shell will move between collapsed handle, copy peek, open panel, and pinned-open states, while clipboard capture only emits events that may trigger those transitions. Automatic copy peeks never take keyboard focus; the panel may become focusable only after explicit hover, click, or shortcut interaction, preventing clipboard feedback from interrupting the application the user is working in.
