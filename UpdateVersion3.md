# EduCrate — Update Version 3.0

**Release Date:** March 8, 2026

---

## Bug Fixes

### 1. Mobile Download Button
- **Problem:** On mobile devices, clicking the download button redirected to Google Drive's URL, which triggered a Google account picker instead of downloading the PDF.
- **Fix:** The `/api/download/:fileId` endpoint now streams the PDF bytes through the server with `Content-Disposition: attachment`, bypassing Google's auth flow. The frontend uses `fetch` → `blob` → `createObjectURL` → programmatic click to force a real file download on all devices.
- **Result:** Downloads start instantly on both mobile and desktop without any account selection prompt.

### 2. Mobile Back Swipe Exits Website
- **Problem:** When a PDF was open in the modal and the user swiped back on mobile, the entire website navigated away instead of closing the PDF viewer.
- **Fix:** Opening a PDF now pushes a browser history entry via `history.pushState()`. A `popstate` listener catches the back navigation and closes the modal. The close button and Escape key also handle history cleanup correctly.
- **Result:** Swiping back on mobile closes the PDF viewer and returns to the file list.

### 3. Modal Scroll Position Loss
- **Problem:** Opening the PDF modal on iOS with `position: fixed; width: 100%` on the body caused the page to jump to the top, losing the user's scroll position.
- **Fix:** Replaced with `overflow: hidden` only — the full-screen fixed modal covers the viewport without repositioning the body.
- **Result:** Scroll position is preserved when opening and closing the PDF viewer.

---

## UI Updates

### 1. PDF Thumbnail Previews
- Added thumbnail preview images on each file card, similar to WhatsApp document previews.
- Thumbnails are fetched from Google Drive's `thumbnailLink` field and served through a server-side proxy (`/api/thumbnail/:fileId`) to bypass CORS restrictions.
- Thumbnails are displayed in a 16:9 aspect ratio with graceful fallback to a PDF icon if unavailable.

### 2. Pull-to-Refresh (Mobile)
- Added native-feeling pull-to-refresh gesture on mobile.
- A floating indicator appears showing "Pull to refresh" → "Release to refresh" → "Refreshing..." with a spinning icon.
- Triggers a full refresh of both folders and current file list.

### 3. Removed Manual Refresh Button
- The manual refresh button in the content header has been removed.
- Replaced by automatic background sync (see below) and pull-to-refresh on mobile.

### 4. Download Button Text on Mobile
- The download button in the PDF viewer now shows "DOWNLOAD" text on mobile alongside the icon (previously icon-only on small screens).
- The "DOWNLOADING..." state with spinner is also visible on mobile for clear feedback.

### 5. Favicon
- Added a proper favicon (`favicon.png` and `favicon.ico`) generated from the app logo at 128×128 resolution.

---

## Performance & Efficiency

### 1. Cached Google Drive Client
- **Before:** `initDriveClient()` re-parsed the service account JSON credentials on every single API request.
- **After:** The Drive client is created once and cached in memory. Subsequent requests reuse the same authenticated client.
- **Impact:** Eliminates redundant JSON parsing and auth object creation on every request.

### 2. Cached Intl.Collator
- **Before:** A new `Intl.Collator` instance was created on every comparison in `naturalSort()`.
- **After:** A single shared `naturalCollator` instance is created at module load and reused.
- **Impact:** Reduces garbage collection pressure during sorting operations.

### 3. Tab Visibility Polling Control
- **Before:** Polling timers (30s files, 60s folders) continued running even when the browser tab was hidden/backgrounded.
- **After:** Polling pauses when `document.hidden` is true and resumes with an immediate sync when the tab becomes active again.
- **Impact:** Saves battery life and network bandwidth on mobile devices when the app isn't being actively used.

### 4. Event Listener Leak Prevention
- **Before:** `renderFolders()`, `renderFiles()`, and `renderSearchResults()` added new click event listeners on every re-render without removing previous ones, causing listener stacking.
- **After:** Previous listeners are removed via `removeEventListener()` before new ones are added.
- **Impact:** Prevents memory leaks and duplicate event handler execution during long sessions.

### 5. Reduced Server Cache Times
- Folder list cache: 5 minutes → 1 minute
- File list cache: 5 minutes → 30 seconds
- **Impact:** Drive changes (additions, deletions, renames) reflect on the website faster.

### 6. Auto-Sync Polling Engine
- Folders automatically poll every 60 seconds, files every 30 seconds.
- Uses diff comparison (`areFoldersEqual` / `areFilesEqual`) — UI only updates when actual changes are detected.
- If the currently-viewed folder is deleted from Drive, the UI navigates back to the welcome screen automatically.

### 7. Thumbnail Caching
- Thumbnail proxy responses are cached for 1 hour (`Cache-Control: public, max-age=3600`).
- Thumbnails are loaded with `loading="lazy"` and `decoding="async"` for deferred, non-blocking image loading.

---

## Security

### 1. Rate Limit Increase & Cleanup
- **Rate limit increased** from 30 to 100 requests per minute to accommodate polling + thumbnail loading (a folder with 10 PDFs loads 10 thumbnails at once).
- **Rate limit store cleanup:** A 5-minute interval now purges expired IP entries from the in-memory Map, preventing unbounded server memory growth.

### 2. Thumbnail Endpoint Validation
- The new `/api/thumbnail/:fileId` endpoint validates fileId format with the same regex pattern (`/^[a-zA-Z0-9_-]+$/`) used by all other endpoints.
- Thumbnail fetch uses `AbortSignal.timeout(10000)` to prevent hanging requests.

### 3. Download Endpoint Hardened
- The download endpoint now streams through the server instead of redirecting to Google Drive, preventing exposure of direct Drive URLs to the client.
- File type is verified as PDF before streaming.

### 4. Existing Security Measures (Unchanged)
- Helmet.js with strict Content Security Policy
- CORS restricted to configured origins
- Input sanitization on search queries
- FileId format validation on all endpoints
- XSS prevention via `escapeHtml()` on all user-facing content

---

## Files Changed

| File | Changes |
|------|---------|
| `netlify/functions/api.js` | Cached Drive client, rate limit fixes, thumbnail proxy endpoint, download streaming, reduced cache times |
| `public/script.js` | Auto-sync polling, pull-to-refresh, back swipe fix, event listener fixes, thumbnail cards, visibility API, collator cache |
| `public/index.html` | Favicon, pull-to-refresh indicator, modal scroll fix, download button text |
| `public/favicon.png` | New — 128×128 app favicon |
| `public/favicon.ico` | New — ICO format favicon |
