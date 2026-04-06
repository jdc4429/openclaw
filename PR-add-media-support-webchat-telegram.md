## What does this PR do?

Adds comprehensive media support to OpenClaw across multiple channels:

### 🌐 WebChat (Complete media suite)

**Previously had NO media support - now fully featured:**

**Images:**

- JPEG/JPG
- PNG
- GIF
- WebP

**Audio (local files - streamed via HTTP server on port 18791):**

- OGG (.ogg) - audio/ogg
- MP3 (.mp3) - audio/mpeg
- WAV (.wav) - audio/wav
- FLAC (.flac) - audio/flac
- M4A (.m4a) - audio/mp4
- AAC (.aac) - audio/aac
- Opus (.opus) - audio/opus
- WebM audio (.webm) - audio/webm
- WMA (.wma) - audio/x-ms-wma

**Video (local files - streamed via HTTP server on port 18791):**

- MP4 (.mp4) - video/mp4
- WebM (.webm) - video/webm
- AVI (.avi) - video/x-msvideo
- MOV (.mov) - video/quicktime
- MKV (.mkv) - video/x-matroska
- M4V (.m4v) - video/x-m4v
- MPG/MPEG (.mpg, .mpeg) - video/mpeg

**Social Media Embeds:**

- YouTube
- Twitter/X
- TikTok
- Instagram
- (Other platforms via URL detection)

### 📱 Telegram

**Images:**

- JPEG/JPG
- PNG
- GIF
- WebP

## Platform summary

| Platform | Images | Audio | Video | Social Embeds |
| -------- | ------ | ----- | ----- | ------------- |
| WebChat  | ✅     | ✅    | ✅    | ✅            |
| Telegram | ✅     | ❌    | ❌    | ❌            |

## Implementation details

- Local HTTP media server (port 18791) for WebChat streaming
- Extension-based MIME mapping for audio/video
- MIME detection for images
- Image sanitization for both platforms
- Social media URL pattern matching

## Testing performed

- [x] All image formats (WebChat + Telegram)
- [x] All audio formats (WebChat)
- [x] All video formats (WebChat)
- [x] Social media embeds (WebChat)

## Breaking changes

None - all features are additive.
