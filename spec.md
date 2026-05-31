R-Player is a Tauri music player GUI application with full OS integration

[SYSTEM INTEGRATION]

- Supports global media keys
    - Play, pause, skip forward, skip backward
- User selectable music library path

[UI/UX]

- Simple, clean, modern
    - Album art visible
    - Optional visualizer (FFT bar graph)
- Keyboard shortcuts for all actions
- Shuffle, loop options that apply to the loaded playlist
- All popups should be handle by modals

[PLAYLISTS]

- Default playlists
    - Liked
        - All songs the user has given a thumbs up
    - Ranked
        - Songs in order by their score (see below)
    - Random Unranked
        - Songs that have never been played
    - All songs
    - Users can create custom playlists

[RANKING]

- Every song begins with a score of zero
- Songs can be given a thumbs up giving them +10 points
- Songs skipped in 30 seconds or less lose 2 points, skipped in 1 minute or less lose 1 point
- Songs played until the end gain 1 point
- The song's rank and liked status should be visible on all pages
