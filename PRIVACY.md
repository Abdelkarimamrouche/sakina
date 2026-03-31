# Privacy Policy for Sakina

**Last updated: March 30, 2026**

## Overview

Sakina is a Chrome extension that automatically mutes music in videos using on-device AI. It helps users who prefer to watch video content without background music while keeping speech, podcasts, and ambient sounds audible.

## Data Collection

**Sakina does NOT collect, store, or transmit any personal data.**

### What Sakina Does:

- Analyzes audio from video players in real-time using machine learning
- All AI processing happens locally on your device using TensorFlow.js
- No audio data ever leaves your browser
- Stores your preferences (like sensitivity threshold) in Chrome's local storage

### What Sakina Does NOT Do:

- Track your browsing history
- Collect personal information
- Send data to external servers
- Use cookies or analytics
- Store any user audio data
- Access any data outside the current tab

## Permissions Explained

Sakina requires minimal permissions to function:

| Permission | Purpose |
|------------|---------|
| `activeTab` | Required to access audio from the video in your current tab for real-time music classification |
| `storage` | Saves your preferences locally (enabled/disabled state, sensitivity threshold, mute singing toggle) |

## Third-Party Services

Sakina uses the following open-source technologies that run **entirely in your browser**:

- **TensorFlow.js**: Machine learning framework (runs locally)
- **YAMNet**: Audio classification model (runs locally)

No data is sent to Google, TensorFlow, or any third party. The YAMNet model is bundled with the extension and executes offline after initial download.

## Children's Privacy

Sakina does not collect any data from users of any age, including children under 13.

## Contact

For questions about this privacy policy or the extension, please open an issue on our GitHub repository.

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be posted in the extension's repository and reflected in the "Last updated" date above.

---

*Sakina — Tranquility for your ears.*
