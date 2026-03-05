/**
 * Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import type { Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const SELECTORS = {
  loginfmt: 'input[name="loginfmt"]',
  password: 'input[name="passwd"]',
  submitButton: 'input[type="submit"]', // Usually idSIButton9
  staySignedInYes: 'input[type="submit"][value="Yes"]',
  accountTile: 'div[role="button"][data-test-id]',
} as const;

interface MicrosoftSSOConfig {
  username?: string;
  password?: string;
}

export class MicrosoftSSOFlow {
  private config: MicrosoftSSOConfig;

  constructor(config: MicrosoftSSOConfig) {
    this.config = config;
  }

  /**
   * Execute the complete Microsoft Entra ID SSO login flow.
   * Handles email entry, account picker, password entry, MFA, and "stay signed in" prompt.
   *
   * @param page - Playwright page instance
   * @returns true on successful login (URL contains /d2l/home), false on timeout/failure
   */
  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting Microsoft SSO login flow");
      
      // If we've already reached Brightspace home (fast redirect), we're done
      if (this.isAtBrightspaceHome(page)) {
        log("INFO", "Already at Brightspace home — skipping SSO fields");
        return true;
      }

      log("DEBUG", `Current URL: ${page.url()}`);

      // Step 1: Enter email/username or pick account
      const loginRequired = await this.handleEmailOrAccountPicker(page);
      if (!loginRequired) return true;

      // Step 2: Enter password
      await this.enterPassword(page);

      // Step 3: Handle MFA (manual approval)
      await this.handleMFA(page);

      // Step 4: Handle "Stay signed in?" prompt
      await this.handleStaySignedIn(page);

      // Step 5: Wait for successful redirect to Brightspace home
      await page.waitForURL(/\/d2l\/home|\/d2l\/lp\/homepage/, { timeout: 120000 });
      log("INFO", "Login successful - reached Brightspace home");

      return true;
    } catch (error) {
      // Final check: maybe we reached home during an error?
      if (this.isAtBrightspaceHome(page)) {
        log("INFO", "Reached Brightspace home despite error in flow");
        return true;
      }
      const pageTitle = await page.title().catch(() => "Unknown Title");
      log("ERROR", `Microsoft SSO login flow failed on page: "${pageTitle}"`, error);
      return false;
    }
  }

  private isAtBrightspaceHome(page: Page): boolean {
    const url = page.url();
    return url.includes("/d2l/home") || url.includes("/d2l/lp/homepage");
  }

  private async handleEmailOrAccountPicker(page: Page): Promise<boolean> {
    try {
      log("DEBUG", "Waiting for email field or account picker");
      
      // Wait for email input, account tile, OR the final destination
      const result = await Promise.race([
        page.waitForSelector(SELECTORS.loginfmt, { timeout: 30000 }).then(() => 'email'),
        page.waitForSelector(SELECTORS.accountTile, { timeout: 30000 }).then(() => 'picker'),
        page.waitForURL(/\/d2l\/home|\/d2l\/lp\/homepage/, { timeout: 30000 }).then(() => 'home'),
      ]);

      if (result === 'home') {
        log("INFO", "Automatically reached Brightspace home via silent SSO");
        return false; // No more steps needed
      }

      if (result === 'picker') {
        log("INFO", "Account picker detected — searching for matching account");
        const accountFound = await page.evaluate((username) => {
          if (!username) return false;
          const tiles = Array.from(document.querySelectorAll('div[role="button"][data-test-id]'));
          const targetTile = tiles.find(t => t.textContent?.toLowerCase().includes(username.toLowerCase()));
          if (targetTile) {
            (targetTile as HTMLElement).click();
            return true;
          }
          return false;
        }, this.config.username);

        if (accountFound) {
          log("INFO", "Selected existing account from picker");
          await page.waitForLoadState("networkidle");
          return true; // Still need to check for password/MFA
        }
        
        log("WARN", "Username not found in picker, looking for 'Use another account'");
        const useAnother = await page.waitForSelector('div#otherTile, div[role="button"]:has-text("Use another account")', { timeout: 5000 }).catch(() => null);
        if (useAnother) {
          await useAnother.click();
          await page.waitForSelector(SELECTORS.loginfmt, { timeout: 10000 });
        }
      }

      // If we reach here and it's 'email', we need to enter credentials
      if (!this.config.username) {
        throw new BrowserAuthError("Username is required for SSO login", "credentials");
      }

      log("INFO", "Entering email");
      await page.fill(SELECTORS.loginfmt, this.config.username);
      await page.click(SELECTORS.submitButton);
      await page.waitForLoadState("networkidle");
      return true;
    } catch (error) {
      if (this.isAtBrightspaceHome(page)) return false;
      if (error instanceof BrowserAuthError) throw error;
      throw new BrowserAuthError("Failed to handle email/account picker", "credentials", error as Error);
    }
  }

  private async enterPassword(page: Page): Promise<void> {
    try {
      log("DEBUG", "Waiting for Microsoft login password field");
      // Password field might take a second to appear after entering email
      await page.waitForSelector(SELECTORS.password, { timeout: 20000 });

      if (!this.config.password) {
        throw new BrowserAuthError(
          "Password is required for SSO login",
          "credentials"
        );
      }

      log("INFO", "Entering password");
      await page.fill(SELECTORS.password, this.config.password);
      await page.click(SELECTORS.submitButton);
      
      await page.waitForLoadState("networkidle");
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new BrowserAuthError(
        "Failed to enter password",
        "credentials",
        error as Error
      );
    }
  }

  private async handleMFA(page: Page): Promise<void> {
    try {
      log("WARN", "Waiting for MFA approval on your device...");
      log("INFO", "Timeout: 120 seconds");
      
      // Microsoft MFA can be Duo, Microsoft Authenticator, or phone call/text.
      // We wait for the page to navigate away from the login/MFA screens.
      // Usually, after MFA, it goes to "Stay signed in?" or directly back to Brightspace.
      
      // We look for either the "Stay signed in?" prompt or the Brightspace home URL.
      await Promise.race([
        page.waitForSelector(SELECTORS.staySignedInYes, { timeout: 120000 }),
        page.waitForURL(/\/d2l\/home/, { timeout: 120000 })
      ]);
      
      log("INFO", "MFA approval detected or skipped");
    } catch (error) {
      // If it timed out, it might be because MFA is not required or already handled.
      // But usually it's a real timeout.
      log("DEBUG", "MFA wait finished (either detected, skipped, or timed out)");
    }
  }

  private async handleStaySignedIn(page: Page): Promise<void> {
    try {
      log("DEBUG", "Checking for 'Stay signed in?' prompt");
      const staySignedInButton = await page.waitForSelector(
        SELECTORS.staySignedInYes,
        { timeout: 5000 }
      );
      if (staySignedInButton) {
        log("INFO", "Clicking 'Yes' on 'Stay signed in?' prompt");
        await staySignedInButton.click();
        await page.waitForLoadState("networkidle");
      }
    } catch (error) {
      // Prompt may not appear - this is normal
      log("DEBUG", "No 'Stay signed in?' prompt found (this is normal)");
    }
  }
}
