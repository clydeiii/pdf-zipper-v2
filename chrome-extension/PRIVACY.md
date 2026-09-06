# PDF Zipper Capture — Privacy Policy

_Last updated: 2026-09-05_

PDF Zipper Capture is a personal browser extension. Its single purpose is to capture the web page you are currently viewing as a PDF (plus a Markdown copy of the article text) and send it to **your own self-hosted pdf-zipper-v2 server** for archiving.

## What the extension does with data

- **When you trigger a capture** (toolbar button, Alt+Shift+Z, or the right-click menu), the extension renders the current tab to PDF using Chrome's built-in print engine and extracts the page's article text. It sends the PDF, the text, the page URL and title to the server address built into the extension (`https://pdf.clydeplex.com`). Nothing is sent at any other time, and nothing is sent to any other destination.
- **Selected text**: if you select text before capturing, only that portion is captured.
- **Authentication** to the server is handled by the server's own access layer (Cloudflare Access) using the cookies your browser already holds for that domain. The extension does not read, store or transmit passwords, and it does not access cookies for any other site.

## What the extension does not do

- It does not collect analytics, telemetry, or usage statistics.
- It does not read or send browsing history.
- It does not store any data itself beyond Chrome's transient notification state.
- It does not sell, share, or transfer data to third parties. Data goes only to the server operated by the extension's author, which the author uses as a private reading archive.
- It contains no remote code; all code ships in the extension package.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Read the current page's text and prepare it for printing when you trigger a capture. |
| `debugger` | Render the page to PDF with Chrome's `Page.printToPDF`, the only API that produces a faithful print of the page as you see it. Attached only for the duration of a capture, then detached. |
| `notifications` | Show the capture result. |
| `contextMenus` | Offer "Capture to PDF Zipper" in the right-click menu. |
| Host permission `https://pdf.clydeplex.com/*` | Send captures to the author's server. |

## Contact

Open an issue at <https://github.com/clydeiii/pdf-zipper-v2/issues>.
