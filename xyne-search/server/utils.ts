import type { Context } from "hono"
import { deleteCookie, setCookie } from "hono/cookie"
import type { CookieOptions } from "hono/utils/cookie"
import fs from "node:fs/promises"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import { stopwords as englishStopwords } from "@orama/stopwords/english"
import { OAuth2Client } from "google-auth-library"
import { Apps } from "@/platform/shared/types"
import crypto from "node:crypto"
import type { QueryRouterResponse } from "@/platform/ai/types"
import {
  updateMicrosoftGraphClient,
  type MicrosoftGraphClient,
} from "./integrations/microsoft/client"
import { CustomServiceAuthProvider } from "./integrations/microsoft/utils"
import { scopes } from "./integrations/microsoft/config"
import { MicrosoftEntraId } from "arctic"
import config from "./config"

const Logger = getLogger(Subsystem.Utils)

export const checkAndReadFile = async (path: string) => {
  try {
    await fs.access(path)
    Logger.info(`File exists: ${path}`)

    const data = JSON.parse(await fs.readFile(path, "utf8"))
    return data
  } catch (err) {
    if ((err as ErrnoException).code === "ENOENT") {
      return null
    } else {
      throw err
    }
  }
}

// @ts-ignore
export const progress_callback = (args) => {
  if (args.status != "progress") return
  let n = Math.floor(args.progress / 5)
  let str =
    "\r[" +
    "#".repeat(n) +
    ".".repeat(20 - n) +
    "] " +
    args.file +
    (n == 20 ? "\n" : "")
  process.stdout.write(str)
}

// Non-prod relaxes secure/sameSite so the cookie works on the frontend dev URL.
export const setCookieByEnv = (
  c: Context,
  CookieName: string,
  jwtToken: string,
  opts?: CookieOptions,
) => {
  const env = process.env.NODE_ENV
  if (env === "production") {
    setCookie(c, CookieName, jwtToken, opts)
  } else {
    Logger.info("Setting Cookie")
    setCookie(c, CookieName, jwtToken, {
      ...opts,
      secure: false,
      sameSite: "Lax",
      httpOnly: true,
    })
  }
}

export const deleteCookieByEnv = (
  c: Context,
  CookieName: string,
  opts?: CookieOptions,
) => {
  const env = process.env.NODE_ENV
  if (env === "production") {
    deleteCookie(c, CookieName, opts)
  } else {
    deleteCookie(c, CookieName, {
      ...opts,
      secure: false,
      sameSite: "Lax",
      httpOnly: true,
    })
  }
}

// Narrows `unknown` catch values to a message string.
export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

// Relative timestamps give the LLM a better sense of time.
export const getRelativeTime = (oldTimestamp: number) => {
  // Large values are treated as ms, otherwise as seconds.
  const MILLISECOND_THRESHOLD = 1e10
  const oldTimestampInSeconds =
    oldTimestamp >= MILLISECOND_THRESHOLD
      ? Math.floor(oldTimestamp / 1000)
      : Math.floor(oldTimestamp)

  const now = Math.floor(Date.now() / 1000)
  const difference = now - oldTimestampInSeconds

  const formatter = new Intl.RelativeTimeFormat("en", { style: "narrow" })

  if (difference < 60) return formatter.format(-difference, "second")
  if (difference < 3600)
    return formatter.format(-Math.floor(difference / 60), "minute")
  if (difference < 86400)
    return formatter.format(-Math.floor(difference / 3600), "hour")
  if (difference < 2620800)
    return formatter.format(-Math.floor(difference / 86400), "day")
  if (difference < 31449600)
    return formatter.format(-Math.floor(difference / 2620800), "month")
  return formatter.format(-Math.floor(difference / 31449600), "year")
}

const MAX_RETRIES = 10

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retry logic with exponential backoff and jitter.
 * @param fn - The function to retry.
 * @param context - Context for logging (e.g., function name, additional info).
 * @param retries - Number of retries attempted.
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  context: string,
  app: Apps,
  retries = 0,
  authClient?: OAuth2Client | MicrosoftGraphClient,
): Promise<T> => {
  try {
    return await fn()
  } catch (error: any) {
    Logger.warn(error)
    const isQuotaError =
      error.message.includes("Quota exceeded") || error.code === 429
    // 403s only retried for rate-limit reasons; other 403s are not transient.
    const is403RetryableRateLimitError =
      error.code === 403 &&
      ["userRateLimitExceeded", "rateLimitExceeded"].includes(
        error.errors?.[0]?.reason,
      )

    const isGoogleTimeoutError =
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNABORTED" ||
      error.message.includes("timeout") ||
      error.message.includes("deadline") ||
      error.message.includes("The operation timed out") ||
      error.code === 504 ||
      error.code === 503

    if (
      (isQuotaError || isGoogleTimeoutError || is403RetryableRateLimitError) &&
      retries < MAX_RETRIES
    ) {
      const baseWaitTime = Math.pow(2, retries) * 3000
      const jitter = Math.random() * 800
      const waitTime = baseWaitTime + jitter

      let reason = "Quota/Timeout"
      if (is403RetryableRateLimitError) {
        reason = "403 Rate Limit"
      }

      Logger.info(
        `[${context}] ${reason} error. Retrying after ${waitTime.toFixed(
          0,
        )}ms (Attempt ${retries + 1}/${MAX_RETRIES})`,
      )
      await delay(waitTime)
      return retryWithBackoff(fn, context, app, retries + 1, authClient)
    } else if (
      authClient &&
      (error.code === 401 || error.code === "InvalidAuthenticationToken") &&
      retries < MAX_RETRIES
    ) {
      if (authClient instanceof OAuth2Client) {
        if (IsGoogleApp(app)) {
          Logger.info(`401 encountered, refreshing OAuth access token...`)
          const { credentials } = await authClient?.refreshAccessToken()!
          authClient?.setCredentials(credentials)
          return retryWithBackoff(
            fn,
            context,
            app,
            retries + 1,
            authClient,
          )
        }
        else {
          throw new Error("Provided AppType is not google")
        }
      } else if (IsMicrosoftApp(app)) {
        if (authClient.refreshToken) {
          // OAuth/Delegated authentication
          const microsoft = new MicrosoftEntraId(
            "common",
            authClient.clientId,
            authClient.clientSecret,
            `${config.host}/oauth/callback`,
          )

          const refreshedTokens = await microsoft.refreshAccessToken(
            authClient.refreshToken,
            scopes,
          )
          updateMicrosoftGraphClient(
            authClient,
            refreshedTokens.accessToken(),
            refreshedTokens.refreshToken(),
          )
        } else if (authClient.tenantId) {
          // Service/app-only authentication
          const authProvider = new CustomServiceAuthProvider(
            authClient.tenantId,
            authClient.clientId,
            authClient.clientSecret,
          )
          updateMicrosoftGraphClient(
            authClient,
            await authProvider.getAccessToken(),
          )
        } else {
          throw new Error(
            "Not enough credentials provided for getting access token after expiry",
          )
        }
        return retryWithBackoff(fn, context, app, retries + 1, authClient)
      } else {
        throw new Error("401 error for unsupported app")
      }
    } else {
      Logger.error(
        `[${context}] Failed after ${retries} retries: ${error.message}`,
      )
      throw error
    }
  }
}

export const splitGroupedCitationsWithSpaces = (text: string): string => {
  if (!text || typeof text !== "string") {
    throw new Error("Invalid input text")
  }

  // Only rewrite bracket groups of numbers separated by commas, e.g. [1,2,3].
  return text.replace(
    /\[(\d+(?:\s*,\s*\d+)*)\]/g,
    (match: string, group: string) => {
      const numbers = group
        .split(",")
        .map((n: string) => n.trim())
        .filter((n: string) => n.length > 0)

      if (numbers.length === 0) {
        return match
      }

      return numbers.map((num: string) => `[${num}]`).join(" ")
    },
  )
}

export const removeStopwords = (text: string) => {
  const words = text.split(/\s+/)

  const filteredWords = words.filter((word) => {
    const cleanWord = word.toLowerCase().replace(/[^\w]/g, "")
    return !englishStopwords.includes(cleanWord)
  })
  return filteredWords.join(" ")
}

export const IsGoogleApp = (app: Apps) => {
  return (
    app === Apps.GoogleDrive ||
    app === Apps.Gmail ||
    app === Apps.GoogleCalendar ||
    app === Apps.GoogleWorkspace
  )
}

export const IsMicrosoftApp = (app: Apps) => {
  return (
    app === Apps.MicrosoftDrive ||
    app === Apps.MicrosoftOutlook ||
    app === Apps.MicrosoftCalendar ||
    app === Apps.MicrosoftSharepoint
  )
}

export function scale(val: number): number | null {
  if (!val) return null
  return (2 * Math.atan(val / 4)) / Math.PI
}

// Hash the filename so the raw name isn't exposed in stored data.
export const hashPdfFilename = (filename: string): string => {
  const hashInput = filename
  const hash = crypto.createHash("md5").update(hashInput).digest("hex")

  const newFilename = hash
  Logger.info(`Filename hashed: ${filename} -> ${newFilename}`)
  return newFilename
}

export const interpretDateFromReturnedTemporalValue = (
  value: QueryRouterResponse["filters"],
) => {
  const from = value.startTime ? new Date(value.startTime) : null
  const to = value.endTime ? new Date(value.endTime) : null

  return { fromDate: from, toDate: to }
}
