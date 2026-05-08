"use strict";

const { chromium } = require("playwright");

const AMAZON_URL = "https://www.amazon.com";
const MAX_PAGES = 5;
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

  async searchRankings(keyword, asin, zipCode = "") {
    const result = {
      keyword,
      asin,
      zip_code: zipCode,
      organic_rank: null,
      organic_page: null,
      ad_rank: null,
      ad_page: null,
      total_results: 0,
      pages_scanned: 0,
      error: null,
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    };

    if (!this.browser) {
      result.error = "Browser not started";
      return result;
    }

    // Incognito context — no cookies, cache, or storage
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
      // 1. Navigate to Amazon
      await page.goto(AMAZON_URL, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
      });

      // 2. Set delivery zip code if provided (best-effort, don't fail)
      if (zipCode) {
        await this.setZipCode(page, zipCode);
        await page.waitForTimeout(1500);
      }

      // 3. Search for keyword
      const encodedKw = encodeURIComponent(keyword);
      const searchUrl = `${AMAZON_URL}/s?k=${encodedKw}`;
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
      });

      // Check if Amazon returned a captcha/bot-detection page
      const pageTitle = await page.title();
      if (pageTitle.includes("Robot") || pageTitle.includes("CAPTCHA")) {
        result.error = "Amazon bot detection triggered — try again later";
        return result;
      }
      await page.waitForTimeout(2000);

      // 4. Scan pages
      await this.scanPages(page, asin, result, keyword);

      return result;
    } catch (err) {
      result.error = err.message;
      return result;
    } finally {
      await context.close();
    }
  }

  async setZipCode(page, zipCode) {
    try {
      // Approach 1: Use the AJAX endpoint that sets a session cookie
      await page.goto(
        `${AMAZON_URL}/gp/delivery/ajax/address-change.html?zipCode=${zipCode}`,
        { waitUntil: "domcontentloaded", timeout: 10000 }
      );
      await page.waitForTimeout(800);

      // Navigate back to home to confirm it stuck
      await page.goto(AMAZON_URL, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
      });
      return true;
    } catch {
      // Approach 2: Try the popover UI method
      try {
        await page.goto(AMAZON_URL, {
          waitUntil: "domcontentloaded",
          timeout: DEFAULT_TIMEOUT,
        });

        let locator = page.locator("#glow-ingress-line2");
        if ((await locator.count()) === 0) {
          locator = page.locator("#nav-global-location-popover-link");
        }
        if ((await locator.count()) === 0) {
          locator = page.locator("a[data-action-type='SELECT_DELIVERY_LOCATION']");
        }
        if ((await locator.count()) === 0) return false;

        await locator.first().click();
        await page.waitForTimeout(1500);

        let zipInput = page.locator("#GLUXZipUpdateInput");
        if ((await zipInput.count()) === 0) {
          zipInput = page.locator("#GLUXZipUpdateInput0");
        }
        if ((await zipInput.count()) === 0) {
          zipInput = page.locator("input.a-input-text[type='text']");
        }
        if ((await zipInput.count()) === 0) return false;

        await zipInput.first().fill(zipCode);
        await page.waitForTimeout(500);

        let applyBtn = page.locator("#GLUXZipUpdate");
        if ((await applyBtn.count()) === 0) {
          applyBtn = page.locator("#GLUXZipUpdate-announce");
        }
        if ((await applyBtn.count()) === 0) {
          applyBtn = page.getByRole("button", { name: /Apply|Submit/i });
        }

        if ((await applyBtn.count()) > 0) {
          await applyBtn.first().click();
          await page.waitForTimeout(1500);
        }

        const doneBtn = page.locator("#GLUXConfirmClose, [aria-label='Close'], .a-popover-header button");
        if ((await doneBtn.count()) > 0) {
          await doneBtn.first().click();
          await page.waitForTimeout(500);
        }

        return true;
      } catch {
        return false;
      }
    }
  }

  async scanPages(page, targetAsin, result, keyword) {
    let organicPos = 0;
    let adPos = 0;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (pageNum > 1) {
        const encodedKw = encodeURIComponent(keyword);
        await page.goto(`${AMAZON_URL}/s?k=${encodedKw}&page=${pageNum}`, {
          waitUntil: "domcontentloaded",
          timeout: DEFAULT_TIMEOUT,
        });
        await page.waitForTimeout(2000);
      }

      result.pages_scanned = pageNum;

      // Parse total results (first page only)
      if (pageNum === 1) {
        const totalEl = page.locator("span:has-text('results')").first();
        if ((await totalEl.count()) > 0) {
          const text = await totalEl.textContent();
          const match = text.match(/([\d,]+)\s*results/);
          if (match) {
            result.total_results = parseInt(match[1].replace(/,/g, ""), 10);
          }
        }
      }

      // Find all search result cards
      const cards = page.locator("div[data-asin]:not([data-asin=''])");
      const count = await cards.count();

      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);
        const cardAsin = await card.getAttribute("data-asin");

        const sponsored = await this.isSponsored(card);

        if (sponsored) {
          adPos++;
          if (cardAsin === targetAsin && result.ad_rank === null) {
            result.ad_rank = adPos;
            result.ad_page = pageNum;
          }
        } else {
          organicPos++;
          if (cardAsin === targetAsin && result.organic_rank === null) {
            result.organic_rank = organicPos;
            result.organic_page = pageNum;
          }
        }

        // Early exit if both found
        if (
          result.organic_rank !== null &&
          result.ad_rank !== null
        ) {
          return;
        }
      }

      // Check if next page exists
      const nextBtn = page.locator(
        "a.s-pagination-next:not(.s-pagination-disabled)"
      );
      if ((await nextBtn.count()) === 0) break;

      const foundAny =
        result.organic_rank !== null || result.ad_rank !== null;
      if (!foundAny && pageNum >= 3) break;
    }
  }

  async isSponsored(card) {
    try {
      const sponsored = card.locator('text="Sponsored"');
      if ((await sponsored.count()) > 0) return true;

      const badge = card.locator(
        "span:has-text('Sponsored'), .sponsored-label, " +
          "[aria-label*='Sponsored']"
      );
      if ((await badge.count()) > 0) return true;

      return false;
    } catch {
      return false;
    }
  }
}

module.exports = AmazonScraper;
