/**
 * 薄 HTTP 客户端: 统一超时、错误归一与脱敏。
 * 任何非 2xx 响应抛出 SyncError(带 httpStatus,后续由 classifyError 细化),
 * 所有错误信息经 redact 处理,不泄露凭据。
 */

import { SyncError, SyncErrorCategory, redact } from "../sync/sync-error.js";

export class HttpClient {
  constructor({ baseUrl, token, timeoutMs = 30000, platform = "" } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.timeoutMs = timeoutMs;
    this.platform = platform;
  }

  /**
   * 发起 JSON 请求。
   * @param {object} opts {method, path(以/开头,或完整url), query, body, headers, responseType:"json"|"text"|"arraybuffer"|"raw", timeoutMs}
   * @returns {Promise<{status:number, headers:Headers, data:any, link:string}>}
   */
  async request(opts) {
    const method = (opts.method || "GET").toUpperCase();
    const requestOpts = method === "GET" && opts.noCache
      ? Object.assign({}, opts, { query: Object.assign({}, opts.query || {}, { _sgsp_ts: Date.now() }) })
      : opts;
    const url = this._buildUrl(requestOpts);
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (this.token) headers.Authorization = "token " + this.token;
    let body;
    if (opts.body !== undefined && opts.body !== null) {
      if (opts.body instanceof ArrayBuffer || opts.body instanceof Uint8Array || typeof opts.body === "string") {
        body = opts.body;
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/octet-stream";
      } else {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
        body = JSON.stringify(opts.body);
      }
    }

    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const aborted = err && (err.name === "AbortError" || /abort/i.test(String(err.message || "")));
      throw new SyncError({
        category: aborted ? SyncErrorCategory.TIMEOUT : SyncErrorCategory.NETWORK,
        code: aborted ? "HTTP_TIMEOUT" : "NETWORK_ERROR",
        operation: method + " " + this._safeUrl(opts),
        message: aborted ? "请求超时(" + Math.round(timeoutMs / 1000) + "s)" : "网络连接失败",
        detail: redact(String((err && err.message) || err)),
        retryable: true,
        recoverable: false,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const responseType = opts.responseType || "json";
    const data = await this._parse(response, responseType);
    if (!response.ok) {
      // L3: 错误信封因响应类型不同而形态不同——arraybuffer(如 raw 404)要解码为文本,
      // 否则平台错误正文(如 "Not Found")全部丢失,只剩笼统的 HTTP 状态码
      let apiMessage = "";
      if (responseType === "arraybuffer") {
        try {
          const buf = data instanceof ArrayBuffer
            ? data
            : data && typeof data === "object" && typeof data.byteLength === "number"
              ? data.buffer || data
              : null;
          if (buf) apiMessage = new TextDecoder().decode(new Uint8Array(buf));
        } catch (e) {
          apiMessage = "";
        }
      } else if (data && typeof data === "object") {
        apiMessage = data.message || data.errors || "";
      }
      const message = String(apiMessage).trim();
      apiMessage = message ? message : apiMessage;
      // GitHub 主速率限制以 403 返回(而非 429),仅靠状态码会把限流误判为权限不足
      // 且不重试;识别特征头/正文后归为 RATE_LIMIT,并提取建议等待时间供重试策略退避。
      const rateLimit = this._detectRateLimit(response, message);
      if (rateLimit) {
        throw new SyncError({
          category: SyncErrorCategory.RATE_LIMIT,
          code: "RATE_LIMITED",
          operation: method + " " + this._safeUrl(opts),
          httpStatus: response.status,
          message: "已触发 GitHub API 限流" + (rateLimit.retryDelayMs > 0
            ? "(约 " + Math.ceil(rateLimit.retryDelayMs / 1000) + " 秒后重置)"
            : ""),
          detail: redact(typeof apiMessage === "string" ? apiMessage : JSON.stringify(apiMessage)),
          retryable: true,
          retryDelayMs: rateLimit.retryDelayMs,
          recoverable: false,
        });
      }
      throw new SyncError({
        category: SyncErrorCategory.GIT,
        code: "HTTP_" + response.status,
        operation: method + " " + this._safeUrl(opts),
        httpStatus: response.status,
        message: this._friendlyStatus(response.status, apiMessage),
        detail: redact(typeof apiMessage === "string" ? apiMessage : JSON.stringify(apiMessage)),
        retryable: response.status >= 500 || response.status === 429,
        recoverable: false,
      });
    }
    return { status: response.status, headers: response.headers, data, link: response.headers.get("link") || "" };
  }

  /**
   * 限流识别: 403/429 且满足以下任一特征——
   * - X-RateLimit-Remaining: 0(主速率限制耗尽);
   * - Retry-After 头存在(二次限流);
   * - 错误正文含 "rate limit"(GitHub 主/次限流的固定文案)。
   * 返回 {retryDelayMs}: 优先 Retry-After(秒),其次 X-RateLimit-Reset(纪元秒 − 当前时间)。
   */
  _detectRateLimit(response, apiMessage) {
    if (response.status !== 403 && response.status !== 429) return null;
    const headers = response.headers;
    const remaining = headers ? headers.get("x-ratelimit-remaining") : null;
    const retryAfter = headers ? headers.get("retry-after") : null;
    const resetEpoch = headers ? headers.get("x-ratelimit-reset") : null;
    const textHit = /rate limit/i.test(String(apiMessage || ""));
    if (remaining !== "0" && !retryAfter && !textHit) return null;

    let retryDelayMs = 0;
    if (retryAfter && Number(retryAfter) > 0) {
      retryDelayMs = Number(retryAfter) * 1000;
    } else if (resetEpoch && Number(resetEpoch) > 0) {
      retryDelayMs = Math.max(0, Number(resetEpoch) * 1000 - Date.now());
    }
    return { retryDelayMs: Math.round(retryDelayMs) };
  }

  _buildUrl(opts) {
    let url = opts.url || (this.baseUrl + (opts.path || ""));
    if (opts.query) {
      const qs = Object.keys(opts.query)
        .filter((k) => opts.query[k] !== undefined && opts.query[k] !== null && opts.query[k] !== "")
        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(opts.query[k])))
        .join("&");
      if (qs) url += (url.indexOf("?") >= 0 ? "&" : "?") + qs;
    }
    return url;
  }

  /** 日志用 URL: 不带 query,避免泄露 token 等参数 */
  _safeUrl(opts) {
    return (opts.url || (this.baseUrl + (opts.path || ""))).replace(/\?.*$/, "");
  }

  async _parse(response, type) {
    if (type === "raw") return response;
    if (type === "json") {
      const text = await response.text();
      try {
        return text ? JSON.parse(text) : null;
      } catch (e) {
        return text;
      }
    }
    if (type === "arraybuffer") return response.arrayBuffer();
    return response.text();
  }

  _friendlyStatus(status, apiMessage) {
    const suffix = apiMessage ? "(" + redact(String(apiMessage)).slice(0, 200) + ")" : "";
    switch (status) {
      case 401:
        return "Token 无效或已过期" + suffix;
      case 403:
        return "权限不足或触发 API 限流" + suffix;
      case 404:
        return "仓库、分支或文件不存在,请检查设置" + suffix;
      case 409:
      case 422:
        return "远端引用更新被拒绝(远端已变化或校验失败)" + suffix;
      case 413:
        return "请求体超过平台限制" + suffix;
      default:
        return "Git API 请求失败(HTTP " + status + ")" + suffix;
    }
  }
}
