# Tubeamp

A small desktop player for YouTube music video playlists. Paste a playlist link, press Load, and it plays through the list with the video on top and the controls below.

## Run it

You need Node.js 18 or newer.

```
cd tubeamp
npm install
npm start
```

## Build a standalone app (optional)

```
npm run dist
```

The result lands in `dist/`: a portable .exe on Windows, a .dmg on macOS, an AppImage on Linux.

## What you can paste

A playlist link (`youtube.com/playlist?list=...`), a video link that is inside a playlist (`watch?v=...&list=...`, starts at that video), a mix (`list=RD...`), a single video link, or a bare playlist ID.

The last playlist, position, volume, shuffle and repeat are remembered between launches, as are the window size, position and keep-on-top setting.

## Controls

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Left / Right | Seek 5 seconds |
| Shift + Left / Right | Previous / next track |
| N / P | Next / previous track |
| Up / Down, or mouse wheel over the display | Volume |
| M | Mute |
| S | Shuffle |
| V | Picture: color or LCD |
| R | Repeat: off, all, one |
| Ctrl + L | Open the link field (switches to LIST view) |
| Ctrl + 1 / 2 / 3 | LIST / VIDEO / MINI view |
| Ctrl + M | Cycle through the three views |

Double-click a track (or select it and press Enter) to play it. Click the big time readout to switch between elapsed and remaining.

The LIST / VIDEO / MINI slide switch on the top edge changes the view: LIST shows the video, controls and playlist; VIDEO hides the playlist and keeps the window sized to the picture (drag any edge to make it bigger or smaller); MINI turns the player into its stick remote (display, transport and volume rocker; audio keeps playing). The ON TOP switch keeps the window above other windows.

To load a playlist, press LOAD under the playlist, paste the link and press Enter or LOAD again.

Build your own lists: with the link field open, ADD appends a video (or every video in a pasted playlist) to the current list instead of replacing it. LISTS > + New list starts an empty one; while you are working on your own list, Enter adds. Remove a track with its x or the Delete key. Press SAVE on the playlist screen, type a name and press Enter; the tag reads SAVED until you change the list again. LISTS shows your saved lists (x twice to delete one) and the last five YouTube playlists.

## Good to know

- The window is transparent so the player can have rounded corners and its own shadow. Resize it by dragging any edge or corner. On Linux this needs a desktop with compositing enabled (most have it on by default).

- Some uploaders block playback outside youtube.com. Those tracks get crossed out and skipped automatically.
- The track list is read from the playlist page, which gives the first 100 videos. If that fails the app falls back to asking YouTube's player, which gives up to about 200.
- Ads can still appear; this uses YouTube's official embedded player.
- If you ever see "Error 153", make sure you started the app with `npm start` and not by opening `index.html` directly. The app serves its page from a local address because YouTube refuses to play inside plain files.
