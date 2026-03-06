/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import type { D2LApiClientOptions, ApiVersions, CacheTTLs, TokenData } from "./types.js";
import { DEFAULT_CACHE_TTLS } from "./types.js";
import { TTLCache } from "./cache.js";
import { TokenBucket } from "./rate-limiter.js";
import { discoverVersions } from "./version-discovery.js";
import { ApiError, RateLimitError, NetworkError } from "./errors.js";
import { log } from "../utils/logger.js";

/**
 * D2L API client with authentication, caching, rate limiting, and version discovery.
 *
 * Key features:
 * - Auto-discovers LP/LE versions from /d2l/api/versions/
 * - Supports both Bearer tokens and cookie-based auth (auto-detected via "cookie:" prefix)
 * - Client-side rate limiting using token bucket algorithm
 * - In-memory response caching with per-data-type TTLs
 * - 401 retry logic: retry once with fresh token, then clear and throw
 * - HTTPS-only enforcement
 * - Browser-like User-Agent for requests
 * - Raw response passthrough (no transformation)
 */
export class D2LApiClient {
  public readonly baseUrl: string;
  private readonly tokenManager: D2LApiClientOptions["tokenManager"];
  private readonly cache: TTLCache;
  private readonly rateLimiter: TokenBucket;
  private readonly cacheTTLs: CacheTTLs;
  private readonly timeoutMs: number;
  private readonly onAuthExpired?: () => Promise<boolean>;
  private versions: ApiVersions | null = null;
  private isPrimed: boolean = false;

  constructor(options: D2LApiClientOptions) {
    // HTTPS-only enforcement
    if (options.baseUrl.startsWith("http://")) {
      throw new Error(
        "HTTPS is required for D2L API client. HTTP URLs are not allowed for security reasons.",
      );
    }

    // Strip trailing slash from baseUrl
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenManager = options.tokenManager;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onAuthExpired = options.onAuthExpired;

    // Merge user-provided TTLs with defaults
    this.cacheTTLs = { ...DEFAULT_CACHE_TTLS, ...options.cacheTTLs };

    // Initialize cache and rate limiter
    this.cache = new TTLCache();
    const rateLimitConfig = options.rateLimitConfig ?? {
      capacity: 10,
      refillRate: 3,
    };
    this.rateLimiter = new TokenBucket(
      rateLimitConfig.capacity,
      rateLimitConfig.refillRate,
    );

    log("DEBUG", `D2LApiClient initialized for ${this.baseUrl}`);
  }

  /**
   * Initialize the client by discovering API versions.
   * Must be called before making API requests.
   */
  async initialize(): Promise<void> {
    this.versions = await discoverVersions(this.baseUrl, this.timeoutMs);
    log(
      "INFO",
      `D2L API versions discovered: LP ${this.versions.lp}, LE ${this.versions.le}`,
    );
  }

  /**
   * Get discovered API versions.
   * @throws Error if initialize() hasn't been called yet
   */
  get apiVersions(): ApiVersions {
    if (!this.versions) {
      throw new Error(
        "API client not initialized. Call initialize() before accessing apiVersions.",
      );
    }
    return this.versions;
  }

  /**
   * Prime the session by making a simple GET request.
   * This ensures we have the latest cookies and CSRF tokens from the server.
   */
  async primeSession(): Promise<void> {
    if (this.isPrimed) return;
    try {
      log("DEBUG", "Priming D2L session...");
      await this.get(this.lp("/users/whoami"));
      this.isPrimed = true;
      log("DEBUG", "Session primed successfully");
    } catch (error) {
      log("WARN", "Failed to prime session, continuing anyway", error);
    }
  }

  /**
   * Make a GET request to the D2L API.
   *
   * @param path - API path (e.g., "/d2l/api/lp/1.56/users/whoami")
   * @param options - Request options (ttl for caching)
   * @returns Parsed JSON response (raw, no transformation)
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async get<T>(path: string, options?: { ttl?: number }): Promise<T> {
    // Check cache first
    if (options?.ttl && this.cache.has(path)) {
      log("DEBUG", `Cache hit: ${path}`);
      return this.cache.get(path) as T;
    }

    // Enforce rate limit
    await this.rateLimiter.consume();

    // Get authentication token — auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.tryAutoReauth(path);
    }

    // Make request with retry logic
    try {
      return await this.makeRequest<T>(path, token, "GET", undefined, options);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Final attempt: auto-reauth and retry once
        const freshToken = await this.tryAutoReauth(path);
        return await this.makeRequest<T>(path, freshToken, "GET", undefined, options);
      }
      throw error;
    }
  }

  /**
   * Make a POST request to the D2L API.
   *
   * @param path - API path
   * @param body - Request body (JSON-serializable)
   * @returns Parsed JSON response
   */
  async post<T>(path: string, body: any): Promise<T> {
    // Prime session for CSRF tokens if using cookies
    await this.primeSession();

    // Enforce rate limit
    await this.rateLimiter.consume();

    // Get authentication token — auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.tryAutoReauth(path);
    }

    // Make request with retry logic
    try {
      return await this.makeRequest<T>(path, token, "POST", body);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Final attempt: auto-reauth and retry once
        const freshToken = await this.tryAutoReauth(path);
        return await this.makeRequest<T>(path, freshToken, "POST", body);
      }
      throw error;
    }
  }

  /**
   * Make a POST request to the D2L API using multipart/mixed.
   * Required for certain endpoints like /news/ (even with no attachments).
   *
   * @param path - API path
   * @param body - The JSON metadata part
   * @returns Parsed JSON response
   */
  async postMultipart<T>(path: string, body: any): Promise<T> {
    // Prime session for CSRF tokens if using cookies
    await this.primeSession();

    // Enforce rate limit
    await this.rateLimiter.consume();

    // Get authentication token — auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.tryAutoReauth(path);
    }

    // Make request with retry logic
    try {
      return await this.makeMultipartRequest<T>(path, token, body);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Final attempt: auto-reauth and retry once
        const freshToken = await this.tryAutoReauth(path);
        return await this.makeMultipartRequest<T>(path, freshToken, body);
      }
      throw error;
    }
  }

  /**
   * Internal method to make a multipart/mixed request.
   */
  private async makeMultipartRequest<T>(
    path: string,
    token: TokenData,
    jsonBody: any,
    isRetry: boolean = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    // Build multipart/mixed body
    const boundary = "xx-brightspace-mcp-boundary-xx";
    headers["Content-Type"] = `multipart/mixed; boundary=${boundary}`;

    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=utf-8",
      "",
      JSON.stringify(jsonBody),
      `--${boundary}--`,
      ""
    ].join("\r\n");

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} POST (multipart) ${path}`);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Same 401/429/403/non-OK handling as makeRequest
      if (response.status === 401) {
        if (isRetry) {
          await this.tokenManager.clearToken();
          throw new ApiError(401, path, "Session expired.");
        }
        const freshToken = await this.tokenManager.getToken();
        if (!freshToken || freshToken.accessToken === token.accessToken) {
          await this.tokenManager.clearToken();
          throw new ApiError(401, path, "Session expired.");
        }
        return await this.makeMultipartRequest<T>(path, freshToken, jsonBody, true);
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        throw new RateLimitError(path, retryAfter ? parseInt(retryAfter, 10) : undefined);
      }

      if (!response.ok) {
        const text = await response.text();
        log("ERROR", `API error response (multipart, ${response.status}): ${text}`);
        throw new ApiError(response.status, path, text);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof ApiError || error instanceof RateLimitError || error instanceof NetworkError) {
        throw error;
      }
      throw new NetworkError(`Request to ${path} failed: ${error}`, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Make a GET request to the D2L API and return raw Response object.
   * Used for binary file downloads where JSON parsing is not desired.
   * Does NOT cache responses (file downloads shouldn't be cached).
   *
   * @param path - API path (e.g., "/d2l/api/le/1.91/123456/content/topics/789/file")
   * @returns Raw Response object for binary data extraction
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async getRaw(path: string): Promise<Response> {
    // Enforce rate limit
    await this.rateLimiter.consume();

    // Get authentication token — auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.tryAutoReauth(path);
    }

    // Make request with retry logic
    try {
      return await this.makeRawRequest(path, token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Final attempt: auto-reauth and retry once
        const freshToken = await this.tryAutoReauth(path);
        return await this.makeRawRequest(path, freshToken);
      }
      throw error;
    }
  }

  /**
   * Attempt auto-reauthentication via the onAuthExpired callback.
   * If successful, returns the fresh token. Otherwise throws 401 ApiError.
   */
  private async tryAutoReauth(path: string): Promise<TokenData> {
    if (this.onAuthExpired) {
      log("INFO", "Attempting auto-reauthentication...");
      const success = await this.onAuthExpired();
      if (success) {
        const freshToken = await this.tokenManager.getToken();
        if (freshToken) {
          log("INFO", "Auto-reauthentication succeeded, retrying request");
          return freshToken;
        }
      }
      log("WARN", "Auto-reauthentication did not produce a valid token");
    }
    throw new ApiError(401, path, "Session expired. Please re-authenticate via brightspace-auth.");
  }

  /**
   * Internal method to make HTTP request with 401 retry logic.
   */
  private async makeRequest<T>(
    path: string,
    token: TokenData,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: any,
    options?: { ttl?: number },
    isRetry: boolean = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    if (body) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} ${method} ${path}`);

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Handle 401 with retry logic
      if (response.status === 401) {
        if (isRetry) {
          // Second 401 - clear token and throw
          log("DEBUG", "Second 401 response, clearing token");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // First 401 - try to get fresher token
        log("DEBUG", "First 401 response, attempting retry with fresh token");
        const freshToken = await this.tokenManager.getToken();

        if (!freshToken || freshToken.accessToken === token.accessToken) {
          // No fresher token available
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // Retry with fresh token
        return await this.makeRequest<T>(path, freshToken, method, body, options, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        log("ERROR", `API error response (${response.status}): ${responseText}`);
        throw new ApiError(response.status, path, responseText);
      }

      // Parse and cache response
      const data: T = await response.json();

      if (options?.ttl && method === "GET") {
        this.cache.set(path, data, options.ttl);
        log("DEBUG", `Cached response for ${path} (TTL: ${options.ttl}ms)`);
      }

      return data;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${method} ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Internal method to make HTTP request for raw binary data with 401 retry logic.
   */
  private async makeRawRequest(
    path: string,
    token: TokenData,
    isRetry: boolean = false,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} GET ${path} (raw)`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Handle 401 with retry logic
      if (response.status === 401) {
        if (isRetry) {
          // Second 401 - clear token and throw
          log("DEBUG", "Second 401 response, clearing token");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // First 401 - try to get fresher token
        log("DEBUG", "First 401 response, attempting retry with fresh token");
        const freshToken = await this.tokenManager.getToken();

        if (!freshToken || freshToken.accessToken === token.accessToken) {
          // No fresher token available
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // Retry with fresh token
        return await this.makeRawRequest(path, freshToken, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses or no access)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle 404 (file not found)
      if (response.status === 404) {
        throw new ApiError(404, path, "File not found");
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        log("ERROR", `API error response (raw, ${response.status}): ${responseText}`);
        throw new ApiError(response.status, path, responseText);
      }

      // Return raw response for caller to process
      return response;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Build authentication headers for a request.
   * Supports both Bearer tokens and cookie-based auth.
   */
  private buildAuthHeaders(token: TokenData): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent":
        "BrightspaceMCP/1.0 (Rohan Muppa; github.com/rohanmuppa/brightspace-mcp-server)",
      "Origin": this.baseUrl,
      "Referer": `${this.baseUrl}/d2l/home`,
    };

    // Auto-detect cookie vs Bearer auth based on "cookie:" prefix
    if (token.accessToken.startsWith("cookie:")) {
      // Cookie-based auth: strip prefix and set Cookie header
      const cookieString = token.accessToken.substring(7);
      headers["Cookie"] = cookieString;
      log("DEBUG", "Using cookie-based authentication");

      // Extract CSRF token (d2l_rf) from cookies if present
      const csrfMatch = cookieString.match(/d2l_rf=([^;]+)/);
      if (csrfMatch && csrfMatch[1]) {
        headers["X-Csrf-Token"] = csrfMatch[1];
        log("DEBUG", `CSRF token extracted: ${csrfMatch[1].substring(0, 5)}...`);
      } else {
        log("WARN", "No d2l_rf cookie found in session! POST requests will likely fail.");
        log("DEBUG", `Cookie string preview: ${cookieString.substring(0, 50)}...`);
      }
    } else {
      // Bearer token auth
      headers["Authorization"] = `Bearer ${token.accessToken}`;
      log("DEBUG", "Using Bearer token authentication");
    }

    return headers;
  }

  /**
   * Build path for LP (Learning Platform) API endpoints.
   * @param path - Path within LP API (e.g., "/users/whoami")
   * @returns Full versioned path (e.g., "/d2l/api/lp/1.56/users/whoami")
   */
  lp(path: string): string {
    const { lp } = this.apiVersions;
    return `/d2l/api/lp/${lp}${path}`;
  }

  /**
   * Build path for LE (Learning Environment) API endpoints with orgUnitId.
   * @param orgUnitId - Organizational unit ID (course ID)
   * @param path - Path within LE API (e.g., "/content/root/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/123456/content/root/")
   */
  le(orgUnitId: number, path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}/${orgUnitId}${path}`;
  }

  /**
   * Build path for global LE (Learning Environment) API endpoints without orgUnitId.
   * @param path - Path within LE API (e.g., "/enrollments/myenrollments/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/enrollments/myenrollments/")
   */
  leGlobal(path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}${path}`;
  }

  /**
   * Clear all cached responses.
   */
  clearCache(): void {
    this.cache.clear();
    log("DEBUG", "Cache cleared");
  }

  /**
   * Get current cache size (number of cached entries).
   */
  get cacheSize(): number {
    return this.cache.size;
  }
}
