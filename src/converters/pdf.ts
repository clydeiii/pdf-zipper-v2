import { initBrowser } from '../browsers/manager.js';
import { loadCookies } from '../browsers/cookies.js';
import { env } from '../config/env.js';
import type { PDFOptions, PDFResult } from './types.js';

/**
 * Check if a URL is a Twitter/X URL
 */
function isTwitterUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'x.com' || host === 'twitter.com' || host === 'www.x.com' || host === 'www.twitter.com';
  } catch {
    return false;
  }
}

/**
 * Rewrite Twitter/X URLs to use Nitter for better PDF capture
 * Nitter provides cleaner rendering and includes reply threads
 *
 * @param url - Original URL
 * @returns Rewritten URL (or original if not Twitter/X)
 */
function rewriteTwitterUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Check if it's a Twitter/X URL
    if (host === 'x.com' || host === 'twitter.com' || host === 'www.x.com' || host === 'www.twitter.com') {
      // Rewrite to Nitter: keep the path (e.g., /user/status/123)
      const nitterUrl = `${env.NITTER_HOST}${parsed.pathname}`;
      console.log(`Rewriting Twitter URL: ${url} → ${nitterUrl}`);
      return nitterUrl;
    }
  } catch {
    // URL parsing failed, return original
  }
  return url;
}

/**
 * Convert a URL to a PDF buffer
 *
 * Handles navigation timeouts, bot detection, and other errors gracefully by
 * returning failure results instead of throwing exceptions.
 *
 * Always closes the browser context to prevent memory leaks.
 *
 * @param url - The URL to convert to PDF
 * @param options - PDF conversion options
 * @returns Promise resolving to either a success or failure result
 */
export async function convertUrlToPDF(
  url: string,
  options: PDFOptions = {}
): Promise<PDFResult> {
  // Extract options with defaults
  // Note: 60s timeout for SPA-heavy sites (OpenAI, etc)
  const {
    timeout = 60000,
    waitAfterLoad = 1000,
    format = 'A4',
    margin = { top: '20px', right: '20px', bottom: '20px', left: '20px' }
  } = options;

  // Get browser (lazy init) and create context
  // Use 1280px viewport for rendering (sites may not render properly at narrow widths)
  // The PDF will scale content to fit A4
  const browser = await initBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  // Load cookies for authentication (paywalls, subscriptions)
  const cookies = loadCookies();
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  try {
    const page = await context.newPage();

    // Rewrite Twitter/X URLs to Nitter for better capture
    const targetUrl = rewriteTwitterUrl(url);

    // Navigate with timeout
    // Try networkidle first for complete page load, fallback to domcontentloaded for heavy SPAs
    let navigationSucceeded = false;
    try {
      await page.goto(targetUrl, {
        timeout,
        waitUntil: 'networkidle'  // Wait for network to be idle (better for heavy JS sites)
      });
      navigationSucceeded = true;
    } catch (error) {
      // Check for timeout errors - retry with domcontentloaded for heavy SPA sites
      if (error instanceof Error && error.name === 'TimeoutError') {
        console.log(`networkidle timeout for ${url}, retrying with domcontentloaded...`);
        try {
          // Fresh page for retry
          await page.goto(targetUrl, {
            timeout,
            waitUntil: 'domcontentloaded'
          });
          // Extra wait for JS to render
          await page.waitForTimeout(5000);
          navigationSucceeded = true;
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          return {
            success: false,
            url,
            error: `Navigation failed after retry: ${retryMsg}`,
            reason: 'timeout'
          };
        }
      } else {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check for common bot detection patterns in error message
        if (errorMsg.includes('net::ERR_BLOCKED') || errorMsg.includes('403')) {
          return {
            success: false,
            url,
            error: errorMsg,
            reason: 'bot_detected'
          };
        }

        return {
          success: false,
          url,
          error: errorMsg,
          reason: 'navigation_error'
        };
      }
    }

    // Wait for JS rendering and ensure body is present
    await page.waitForTimeout(waitAfterLoad);

    // Wait for body to be present (some SPAs take time to hydrate)
    try {
      await page.waitForSelector('body', { timeout: 5000 });
    } catch {
      // Body selector failed, continue anyway
    }

    // Extra wait for heavy JS sites
    await page.waitForTimeout(2000);

    // Scroll through page to trigger lazy-loaded images (especially for Nitter)
    // Fast scroll with minimal delay - just need to trigger image loading
    try {
      await Promise.race([
        page.evaluate(`(async () => {
          const delay = ms => new Promise(r => setTimeout(r, ms));
          const scrollStep = 1000;
          const maxScrolls = 50;
          let scrollCount = 0;

          while (scrollCount < maxScrolls) {
            window.scrollBy(0, scrollStep);
            await delay(50);
            scrollCount++;

            const scrollPosition = window.scrollY + window.innerHeight;
            if (scrollPosition >= document.documentElement.scrollHeight - 10) {
              break;
            }
          }

          window.scrollTo(0, 0);
        })()`),
        new Promise(resolve => setTimeout(resolve, 10000)) // 10s timeout for scroll
      ]);
    } catch {
      // Scroll failed, continue with PDF generation anyway
    }

    // Brief wait for lazy-loaded images
    await page.waitForTimeout(500);

    // For Twitter URLs via Nitter: check if this is an article stub
    // Nitter doesn't support X Articles and just shows a link like "x.com/i/article/..."
    if (isTwitterUrl(url) && targetUrl !== url) {
      const pageContent = await page.content();
      if (pageContent.includes('x.com/i/article/') || pageContent.includes('twitter.com/i/article/')) {
        console.log(`Nitter returned article stub for ${url}, retrying with direct X.com`);
        // Close current page and retry with original URL
        await page.close();
        const directPage = await context.newPage();
        await directPage.goto(url, {
          timeout,
          waitUntil: 'domcontentloaded'
        });
        // Wait longer for X.com JS rendering
        await directPage.waitForTimeout(3000);
        // Continue with directPage for PDF generation
        await directPage.emulateMedia({ media: 'screen' });
        // Use CSS-only approach to hide fixed/sticky elements (avoids expensive DOM traversal)
        await directPage.addStyleTag({
          content: `
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

            /* Force all links and their contents to be visible */
            a, a *, a span, a strong, a em, a b, a i {
              visibility: visible !important;
              opacity: 1 !important;
              color: inherit !important;
              background-clip: border-box !important;
              -webkit-background-clip: border-box !important;
              -webkit-text-fill-color: currentColor !important;
            }
            a { display: inline !important; position: static !important; }

            /* Hide inline-styled fixed/sticky elements */
            [style*="position: fixed"], [style*="position:fixed"],
            [style*="position: sticky"], [style*="position:sticky"] {
              display: none !important;
            }
            /* Force common sticky/fixed elements to static positioning */
            header, nav, footer, aside,
            .header, .nav, .navbar, .footer, .sidebar,
            .sticky, .fixed, .floating, .toolbar, .topbar, .bottombar,
            [class*="sticky"], [class*="fixed"], [class*="floating"],
            [class*="navbar"], [class*="header"], [class*="toolbar"],
            [role="banner"], [role="navigation"], [role="complementary"] {
              position: static !important;
            }
          `
        });
        // Take screenshot for quality verification
        const screenshotBuffer = await directPage.screenshot({
          type: 'png',
          fullPage: false,
        });
        const pdfBuffer = await directPage.pdf({
          format,
          printBackground: true,
          margin,
          preferCSSPageSize: false,
          scale: 0.7
        });
        return {
          success: true,
          pdfBuffer: Buffer.from(pdfBuffer),
          screenshotBuffer: Buffer.from(screenshotBuffer),
          url,
          size: pdfBuffer.length
        };
      }
    }

    // Take screenshot BEFORE any modifications for quality check
    // Wrap in timeout to avoid font loading hangs
    let screenshotBuffer: Buffer;
    try {
      screenshotBuffer = Buffer.from(await Promise.race([
        page.screenshot({ type: 'png', fullPage: false }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Screenshot timeout')), 15000)
        )
      ]));
    } catch {
      // Screenshot failed, use empty buffer - PDF will still generate
      screenshotBuffer = Buffer.alloc(0);
    }

    // Preserve screen formatting (not print CSS)
    await page.emulateMedia({ media: 'screen' });

    // Add print-friendly styles (wrapped in try-catch for SPAs that might not have body ready)
    try {
    // 1. Preserve colors in print
    // 2. Hide fixed/sticky elements (headers, navbars, floating UI)
    // 3. Prevent text overflow - ensure content fits within page width
    // 4. Force visibility (some sites hide content in print)
    // Use CSS-only approach for print styling (avoids expensive querySelectorAll('*') DOM traversal)
    await page.addStyleTag({
      content: `
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

        /* Force content visibility - some sites hide content in print */
        body, html, main, article, .article, .content, .post, #content, #main {
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          height: auto !important;
          overflow: visible !important;
        }

        /* Force all links and their contents to be visible */
        /* Sites like OpenAI use gradient text (background-clip: text) which breaks PDF capture */
        a, a *, a span, a strong, a em, a b, a i {
          visibility: visible !important;
          opacity: 1 !important;
          color: inherit !important;
          background-clip: border-box !important;
          -webkit-background-clip: border-box !important;
          -webkit-text-fill-color: currentColor !important;
          text-fill-color: currentColor !important;
        }

        /* Ensure inline links display correctly */
        a {
          display: inline !important;
          position: static !important;
        }

        /* Nitter-specific: hide overlay links that break PDF layout */
        .tweet-link {
          display: none !important;
        }

        /* Nitter-specific: ensure timeline items have proper layout */
        .timeline-item, .tweet-body, .main-tweet, .after-tweet {
          position: relative !important;
          display: block !important;
          width: auto !important;
          height: auto !important;
        }

        /* Hide inline-styled fixed/sticky elements */
        [style*="position: fixed"], [style*="position:fixed"],
        [style*="position: sticky"], [style*="position:sticky"] {
          display: none !important;
        }

        /* Force common sticky/fixed elements to static positioning (catches CSS-set positions) */
        header, nav, footer, aside,
        .header, .nav, .navbar, .footer, .sidebar,
        .sticky, .fixed, .floating, .toolbar, .topbar, .bottombar,
        [class*="sticky"], [class*="fixed"], [class*="floating"],
        [class*="navbar"], [class*="header"], [class*="toolbar"],
        [role="banner"], [role="navigation"], [role="complementary"] {
          position: static !important;
        }

        /* Prevent content overflow */
        body, html {
          max-width: 100% !important;
          overflow-x: hidden !important;
        }

        /* Ensure text wraps properly */
        p, span, div, li, td, th, h1, h2, h3, h4, h5, h6, a {
          word-wrap: break-word !important;
          overflow-wrap: break-word !important;
          max-width: 100% !important;
        }

        /* Prevent wide elements from overflowing */
        img, video, iframe, table, pre, code {
          max-width: 100% !important;
          height: auto !important;
        }

        /* Handle pre/code blocks */
        pre, code {
          white-space: pre-wrap !important;
          word-break: break-word !important;
        }

        /* Normalize footnote/citation superscripts */
        /* Some sites (darioamodei.com) style sup as "pills" with padding/background */
        /* which can cause vertical rendering issues in PDFs */
        sup, sub {
          display: inline !important;
          vertical-align: super !important;
          font-size: 0.75em !important;
          line-height: 0 !important;
          position: relative !important;
          padding: 0 !important;
          margin: 0 2px !important;
          background: transparent !important;
          border-radius: 0 !important;
        }
        sub {
          vertical-align: sub !important;
        }

        /* Ensure footnote links display inline */
        sup a, .footnote-ref, a.footnote-ref {
          display: inline !important;
          background: transparent !important;
          padding: 0 !important;
          text-decoration: none !important;
        }

        /* Hide footnote tooltips/popovers that appear on hover */
        /* These can render incorrectly (vertically) in PDFs */
        .footnote-tooltip, [class*="tooltip"], [class*="popover"],
        [role="tooltip"], [data-tooltip], .tippy-box, .tippy-content {
          display: none !important;
          visibility: hidden !important;
        }
      `
    });
    } catch (styleError) {
      // Style injection failed - continue with PDF generation anyway
      console.warn(`Style injection failed for ${url}: ${styleError instanceof Error ? styleError.message : styleError}`);
    }

    // Generate PDF with scale to fit wide content on A4
    // 1280px viewport → 595pt A4 width requires ~0.8 scale
    const pdfBuffer = await page.pdf({
      format,
      printBackground: true,
      margin,
      preferCSSPageSize: false,
      scale: 0.7
    });

    return {
      success: true,
      pdfBuffer: Buffer.from(pdfBuffer),
      screenshotBuffer: Buffer.from(screenshotBuffer),
      url,
      size: pdfBuffer.length
    };

  } finally {
    // CRITICAL: Always close context to prevent memory leaks
    await context.close();
  }
}
