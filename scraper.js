"use strict";

const { chromium } = require("playwright");

const AMAZON_URL = "https://www.amazon.com";
const MAX_PAGES = 3;
const MAX_AD_REFRESH = 10;
const DEFAULT_TIMEOUT = 30000;

class AmazonScraper {
  constructor(headless = true) {
    this.headless = headless;
    this.browser = null;
  }

  async start() {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        "--incognito",
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    });
  }

  async stop() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ── Public: single ASIN search (wraps batch) ────────────────────────────

  async searchRankings(keyword, asin, zipCode = "") {
    const map = await this.batchSearchRankings(keyword, [asin], zipCode);
    return map[asin] || this._emptyResult(keyword, asin, zipCode, "not_found");
  }

  // ── Public: batch search — one page load for multiple ASINs ─────────────

  async batchSearchRankings(keyword, asins, zipCode = "") {
    const resultMap = {};
    for (const a of asins) {
      resultMap[a] = this._emptyResult(keyword, a, zipCode, "not_found");
    }
    const targetSet = new Set(asins);

    if (!this.browser) {
      for (const a of asins) resultMap[a].error = "Browser not started";
      return resultMap;
    }

    const context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
    });
    const page = await context.newPage();

    try {
      // Go directly to search (skip homepage + zip UI — unreliable from non-US IPs)
      const encodedKw = encodeURIComponent(keyword);
      const searchUrl = `${AMAZON_URL}/s?k=${encodedKw}&i=aps`;
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
      });

      // 4. Check bot detection
      const pageTitle = await page.title();
      if (pageTitle.includes("Robot") || pageTitle.includes("CAPTCHA")) {
        for (const a of asins) resultMap[a].error = "Bot detection triggered";
        return resultMap;
      }
      await page.waitForTimeout(2000);

      // 5. Scan organic results first (no refresh needed)
      let adsSeen = false;

      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        if (pageNum > 1) {
          await page.goto(`${AMAZON_URL}/s?k=${encodedKw}&i=aps&page=${pageNum}`, {
            waitUntil: "domcontentloaded",
            timeout: DEFAULT_TIMEOUT,
          });
          await page.waitForTimeout(2000);
        }

        const cards = page.locator("div[data-asin]:not([data-asin=''])");
        const count = await cards.count();
        if (count === 0) break;

        let remaining = new Set([...targetSet].filter(
          a => resultMap[a].organic_pos === null
        ));
        if (remaining.size === 0) break;

        let pageOrganicPos = 0;
        let pageAdPos = 0;

        for (let i = 0; i < count; i++) {
          const card = cards.nth(i);
          const cardAsin = await card.getAttribute("data-asin");
          const sponsored = await this._isSponsored(card);

          if (sponsored) {
            pageAdPos++;
            adsSeen = true;
            if (cardAsin && targetSet.has(cardAsin) &&
                resultMap[cardAsin].ad_pos === null) {
              resultMap[cardAsin].ad_page = pageNum;
              resultMap[cardAsin].ad_pos = pageAdPos;
              resultMap[cardAsin].ad_status = "found";
            }
          } else {
            pageOrganicPos++;
            if (cardAsin && targetSet.has(cardAsin) &&
                resultMap[cardAsin].organic_pos === null) {
              resultMap[cardAsin].organic_page = pageNum;
              resultMap[cardAsin].organic_pos = pageOrganicPos;
              resultMap[cardAsin].organic_status = "found";
            }
          }
        }

        const nextBtn = page.locator(
          "a.s-pagination-next:not(.s-pagination-disabled)"
        );
        if (await nextBtn.count() === 0) break;
      }

      // 6. Ads: if no ads seen at all, try ONE refresh for ad positions
      if (!adsSeen) {
        // check if ads exist on the page at all
        const sponsoredEls = page.locator('text="Sponsored"');
        if (await sponsoredEls.count() === 0) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
          await page.waitForTimeout(2000);
        }
        const hasAds = (await page.locator('text="Sponsored"').count()) > 0;
        if (hasAds) {
          const adCards = page.locator("div[data-asin]:not([data-asin=''])");
          const adCount = await adCards.count();
          let pgAd = 0;
          for (let i = 0; i < adCount; i++) {
            const card = adCards.nth(i);
            const cardAsin = await card.getAttribute("data-asin");
            if (await this._isSponsored(card)) {
              pgAd++;
              if (cardAsin && targetSet.has(cardAsin) && resultMap[cardAsin].ad_pos === null) {
                resultMap[cardAsin].ad_page = 1;
                resultMap[cardAsin].ad_pos = pgAd;
                resultMap[cardAsin].ad_status = "found";
              }
            }
          }
        } else {
          for (const a of asins) {
            if (resultMap[a].ad_pos === null) {
              resultMap[a].ad_status = "not_loaded";
            }
          }
        }
      }

    } catch (err) {
      for (const a of asins) {
        if (!resultMap[a].error) resultMap[a].error = err.message;
      }
    } finally {
      await context.close();
    }

    return resultMap;
  }

  // ── Ad loading check + refresh loop ────────────────────────────────────

  async _ensureAdsLoaded(page, keyword) {
    for (let attempt = 0; attempt < MAX_AD_REFRESH; attempt++) {
      if (attempt > 0) {
        // Refresh the page
        await page.reload({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        await page.waitForTimeout(2000);
      }

      // Check if any sponsored element is visible
      const sponsored = page.locator('text="Sponsored"');
      const count = await sponsored.count();
      if (count > 0) return "loaded";

      // Also check for common ad containers
      const adContainer = page.locator(
        "[data-component-type='sp-sponsored-result'], " +
        "[data-component-type='sb-sponsored-result'], " +
        ".s-sponsored-slot"
      );
      if (await adContainer.count() > 0) return "loaded";

      if (attempt < MAX_AD_REFRESH - 1) {
        console.log(`  [Ad check] No ads on attempt ${attempt + 1}/${MAX_AD_REFRESH}, refreshing...`);
        await page.waitForTimeout(500 + Math.random() * 1000);
      }
    }
    console.log(`  [Ad check] Ads not loaded after ${MAX_AD_REFRESH} attempts for "${keyword}"`);
    return "not_loaded";
  }

  // ── Zip code setting ──────────────────────────────────────────────────

  async _setZipCode(page, zipCode) {
    // Go to homepage
    await page.goto(AMAZON_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(1500);

    // Click the "Deliver to" link — try multiple known selectors
    const locationTriggers = [
      "#glow-ingress-line2",
      "#glow-ingress-line1",
      "#nav-global-location-popover-link",
      "#glow-ingress-block",
      "a[href*='address-change']",
    ];
    let clicked = false;
    for (const sel of locationTriggers) {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        await el.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) return false;
    await page.waitForTimeout(2000);

    // Find zip input in the popup — use broad matching
    const zipInputSelectors = [
      "input[id*='GLUX'][id*='Zip']",
      "input[placeholder*='ZIP']",
      "input[placeholder*='zip']",
      "input[aria-label*='zip' i]",
      "input[aria-label*='ZIP']",
      "input[id*='ZipUpdate']",
      "#GLUXZipUpdateInput",
      "#GLUXZipUpdateInput0",
    ];
    let filled = false;
    for (const sel of zipInputSelectors) {
      const inp = page.locator(sel).first();
      if (await inp.count() > 0) {
        await inp.click();
        await inp.fill(zipCode);
        filled = true;
        break;
      }
    }
    if (!filled) return false;
    await page.waitForTimeout(500);

    // Click Apply
    const applySelectors = [
      "#GLUXZipUpdate",
      "#GLUXZipUpdateBtn",
      "button:has-text('Apply')",
      "input[type='submit'][value='Apply']",
      "span:has-text('Apply')",
    ];
    for (const sel of applySelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0) {
        await btn.click();
        break;
      }
    }
    await page.waitForTimeout(2000);
    return true;
  }

  // ── Sponsored detection ───────────────────────────────────────────────

  async _isSponsored(card) {
    try {
      const sponsored = card.locator('text="Sponsored"');
      if ((await sponsored.count()) > 0) return true;
      const badge = card.locator(
        "span:has-text('Sponsored'), .sponsored-label, " +
        "[aria-label*='Sponsored']"
      );
      return (await badge.count()) > 0;
    } catch {
      return false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _emptyResult(keyword, asin, zipCode, adStatus = "not_found") {
    return {
      keyword,
      asin,
      zip_code: zipCode,
      organic_page: null,
      organic_pos: null,
      organic_status: "not_found",
      ad_page: null,
      ad_pos: null,
      ad_status: adStatus,
      total_results: 0,
      error: null,
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    };
  }
}

module.exports = AmazonScraper;
